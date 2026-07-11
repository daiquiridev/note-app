"use strict";
/* defter. — bulut sunucusu v3: çoklu hesap (aynı anda giriş + geçiş), parola sıfırlama (email),
   giriş bildirimleri (Resend). SQLite (node:sqlite), sıfır npm bağımlılığı */
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 80);
const SECRET = process.env.SECRET;
const DATA_DIR = process.env.DATA_DIR || "/data";
const DB_FILE = path.join(DATA_DIR, "defter.db");
const LEGACY_USERS = path.join(DATA_DIR, "users.json");
const MAX_BODY = 25 * 1024 * 1024;                    // 25 MB
const SESSION_MS = 30 * 24 * 3600 * 1000;             // 30 gün
const DEVICE_MS = 400 * 24 * 3600 * 1000;             // 400 gün (Chrome cookie üst sınırı)
const RESET_MS = 30 * 60 * 1000;                      // parola sıfırlama linki: 30 dk

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const MAIL_FROM = process.env.MAIL_FROM || "defter <defter@m.daiquiri.dev>";
const APP_URL = process.env.APP_URL || "https://defter.daiquiri.dev";
const STT_WORKER_URL = process.env.STT_WORKER_URL || "";
const STT_WORKER_SECRET = process.env.STT_WORKER_SECRET || "";

if (!SECRET) { console.error("SECRET ortam değişkeni gerekli"); process.exit(1); }

/* ── veritabanı ── */
const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA busy_timeout=5000");
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  created INTEGER NOT NULL,
  session_version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS items(
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  updated INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL,
  json TEXT,
  PRIMARY KEY(user_id, kind, id)
);
CREATE INDEX IF NOT EXISTS idx_items_user ON items(user_id, deleted);
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  user_id UNINDEXED, kind UNINDEXED, id UNINDEXED, title, body,
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS meta(
  user_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS password_resets(
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS known_devices(
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  created INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY(user_id, device_id)
);
CREATE TABLE IF NOT EXISTS api_keys(
  key_hash TEXT PRIMARY KEY,
  login_id TEXT NOT NULL,
  label TEXT,
  created INTEGER NOT NULL,
  last_used INTEGER
);
CREATE TABLE IF NOT EXISTS logins(
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  created INTEGER NOT NULL,
  session_version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS oauth_clients(
  client_id TEXT PRIMARY KEY,
  redirect_uris TEXT NOT NULL,
  client_name TEXT,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_codes(
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  login_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS oauth_tokens(
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  login_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  expires INTEGER,
  created INTEGER NOT NULL
);`);
/* eski kurulumlardan yükseltme: yeni kolonlar yoksa ekle */
try { db.exec("ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN login_id TEXT"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN name TEXT"); } catch {}
try { db.exec("ALTER TABLE password_resets ADD COLUMN kind TEXT NOT NULL DEFAULT 'user'"); } catch {}
/* eski api_keys şeması (user_id NOT NULL) varsa login_id'ye taşı — tablo şu ana kadar üretimde fiilen kullanılmadı */
{
  const cols = db.prepare("PRAGMA table_info(api_keys)").all();
  const hasLoginId = cols.some(c => c.name === "login_id");
  const userIdCol = cols.find(c => c.name === "user_id");
  if (!hasLoginId || (userIdCol && userIdCol.notnull)) {
    db.exec("DROP TABLE IF EXISTS api_keys");
    db.exec(`CREATE TABLE api_keys(
      key_hash TEXT PRIMARY KEY,
      login_id TEXT NOT NULL,
      label TEXT,
      created INTEGER NOT NULL,
      last_used INTEGER
    )`);
  }
}

/* ── parola ── */
const hashPass = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString("hex");
function makeHash(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + hashPass(pw, salt);
}
function verifyHash(passHash, pw) {
  try {
    const [salt, hash] = passHash.split(":");
    const h = hashPass(pw, salt);
    return h.length === hash.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash));
  } catch { return false; }
}

/* ── eski dosyalardan göç ── */
function migrate() {
  const userCount = db.prepare("SELECT COUNT(*) c FROM users").get().c;
  if (userCount === 0 && fs.existsSync(LEGACY_USERS)) {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_USERS, "utf8"));
    const ins = db.prepare("INSERT INTO users(id,email,pass_hash,created) VALUES(?,?,?,?)");
    for (const u of legacy) ins.run(u.id, u.email.toLowerCase(), u.passHash, u.created || Date.now());
    fs.renameSync(LEGACY_USERS, LEGACY_USERS + ".imported");
    console.log("göç: users.json → users tablosu (" + legacy.length + " kullanıcı)");
  }
  for (const u of db.prepare("SELECT id FROM users").all()) {
    const has = db.prepare("SELECT COUNT(*) c FROM items WHERE user_id=?").get(u.id).c;
    const f = path.join(DATA_DIR, "u_" + u.id + ".json");
    if (has === 0 && fs.existsSync(f)) {
      try {
        const blob = JSON.parse(fs.readFileSync(f, "utf8"));
        if (blob && blob.data) { syncUser(u.id, 0, blob.data); console.log("göç: " + u.id + " blob → items"); }
      } catch (e) { console.error("göç hatası", u.id, e.message); }
      fs.renameSync(f, f + ".imported");
    }
  }
}

/* ── tam metin arama (FTS5) — items ile aynı anda tutulan, bağımsız türev tablo ── */
function ftsTextFor(kind, obj) {
  if (kind === "note") return { title: obj.title || "", body: noteToText(obj) };
  if (kind === "task") return { title: obj.text || "", body: obj.desc || "" };
  if (kind === "folder") return { title: obj.name || "", body: "" };
  return null; // settings vb. aranmaz
}
function indexFts(uid, kind, id, obj) {
  db.prepare("DELETE FROM items_fts WHERE user_id=? AND kind=? AND id=?").run(uid, kind, id);
  const t = ftsTextFor(kind, obj);
  if (!t) return;
  db.prepare("INSERT INTO items_fts(user_id,kind,id,title,body) VALUES(?,?,?,?,?)").run(uid, kind, id, t.title, t.body);
}
function deindexFts(uid, kind, id) {
  db.prepare("DELETE FROM items_fts WHERE user_id=? AND kind=? AND id=?").run(uid, kind, id);
}
function backfillFts() {
  const done = db.prepare("SELECT COUNT(*) c FROM items_fts").get().c;
  if (done > 0) return; // yalnızca ilk kurulumda — sonrası write noktalarında canlı tutuluyor
  const rows = db.prepare("SELECT user_id,kind,id,json FROM items WHERE deleted=0 AND kind IN ('note','task','folder')").all();
  for (const r of rows) { try { indexFts(r.user_id, r.kind, r.id, JSON.parse(r.json)); } catch {} }
  if (rows.length) console.log("fts: " + rows.length + " öğe geriye dönük indekslendi");
}

/* ── senkron çekirdeği ── */
function collectClientItems(data) {
  const out = [];
  for (const n of data.notes || []) out.push({ kind: "note", id: String(n.id), updated: n.updated || 0, json: n });
  for (const t of data.tasks || []) out.push({ kind: "task", id: String(t.id), updated: t.updated || t.created || 0, json: t });
  for (const f of data.folders || []) out.push({ kind: "folder", id: String(f.id), updated: f.updated || f.created || 0, json: f });
  out.push({
    kind: "settings", id: "main", updated: data.mtime || 0,
    json: { theme: data.theme ?? null, accent: data.accent ?? null, pin: data.pin ?? null, collapsed: data.collapsed || [], tracking: data.tracking ?? null, templates: data.templates || [] }
  });
  return out;
}
function syncUser(uid, baseSeq, data) {
  db.exec("BEGIN");
  try {
    let seq = (db.prepare("SELECT seq FROM meta WHERE user_id=?").get(uid) || { seq: 0 }).seq;
    const rows = new Map(
      db.prepare("SELECT kind,id,updated,deleted,seq FROM items WHERE user_id=?").all(uid)
        .map(r => [r.kind + ":" + r.id, r])
    );
    let changed = false;
    const clientKeys = new Set();
    const up = db.prepare(`INSERT INTO items(user_id,kind,id,updated,deleted,seq,json) VALUES(?,?,?,?,0,?,?)
      ON CONFLICT(user_id,kind,id) DO UPDATE SET updated=excluded.updated,deleted=0,seq=excluded.seq,json=excluded.json`);
    for (const it of collectClientItems(data)) {
      const key = it.kind + ":" + it.id;
      clientKeys.add(key);
      const row = rows.get(key);
      if (!row || it.updated > row.updated) { up.run(uid, it.kind, it.id, it.updated, ++seq, JSON.stringify(it.json)); indexFts(uid, it.kind, it.id, it.json); }
      else if (row.deleted || row.updated > it.updated) changed = true;   // sunucu tarafı daha yeni → istemci güncellenmeli
    }
    const del = db.prepare("UPDATE items SET deleted=1, json=NULL, updated=?, seq=? WHERE user_id=? AND kind=? AND id=?");
    const now = Date.now();
    for (const [key, row] of rows) {
      if (row.deleted || clientKeys.has(key) || row.kind === "settings") continue;
      if (row.seq <= baseSeq) { del.run(now, ++seq, uid, row.kind, row.id); deindexFts(uid, row.kind, row.id); } // istemci biliyordu ve silmiş → tombstone
      else changed = true;                                               // istemcinin görmediği yeni öğe
    }
    db.prepare("INSERT INTO meta(user_id,seq) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET seq=excluded.seq").run(uid, seq);
    db.exec("COMMIT");
    return { seq, changed };
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
function buildState(uid) {
  const rows = db.prepare("SELECT kind,json,updated FROM items WHERE user_id=? AND deleted=0 ORDER BY rowid").all(uid);
  if (!rows.length) return null;
  const s = { notes: [], tasks: [], folders: [], theme: null, accent: null, pin: null, collapsed: [], templates: [], mtime: 0 };
  for (const r of rows) {
    const obj = JSON.parse(r.json);
    if (r.kind === "note") s.notes.push(obj);
    else if (r.kind === "task") s.tasks.push(obj);
    else if (r.kind === "folder") s.folders.push(obj);
    else if (r.kind === "settings") Object.assign(s, obj);
    if (r.updated > s.mtime) s.mtime = r.updated;
  }
  return s;
}
const userSeq = uid => (db.prepare("SELECT seq FROM meta WHERE user_id=?").get(uid) || { seq: 0 }).seq;

/* ── tekil öğe CRUD (MCP için — sync birleştirme mantığını atlar, doğrudan yazar) ── */
function upsertItem(uid, kind, id, obj, updated) {
  db.exec("BEGIN");
  try {
    let seq = (db.prepare("SELECT seq FROM meta WHERE user_id=?").get(uid) || { seq: 0 }).seq;
    seq++;
    db.prepare(`INSERT INTO items(user_id,kind,id,updated,deleted,seq,json) VALUES(?,?,?,?,0,?,?)
      ON CONFLICT(user_id,kind,id) DO UPDATE SET updated=excluded.updated,deleted=0,seq=excluded.seq,json=excluded.json`)
      .run(uid, kind, id, updated, seq, JSON.stringify(obj));
    indexFts(uid, kind, id, obj);
    db.prepare("INSERT INTO meta(user_id,seq) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET seq=excluded.seq").run(uid, seq);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
function deleteItem(uid, kind, id) {
  db.exec("BEGIN");
  try {
    let seq = (db.prepare("SELECT seq FROM meta WHERE user_id=?").get(uid) || { seq: 0 }).seq;
    seq++;
    const r = db.prepare("UPDATE items SET deleted=1, json=NULL, updated=?, seq=? WHERE user_id=? AND kind=? AND id=? AND deleted=0")
      .run(Date.now(), seq, uid, kind, id);
    if (r.changes) { db.prepare("INSERT INTO meta(user_id,seq) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET seq=excluded.seq").run(uid, seq); deindexFts(uid, kind, id); }
    db.exec("COMMIT");
    return !!r.changes;
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
/* öğeleri (not/klasör) bir projeden diğerine taşı — kaynakta tombstone, hedefte yeni seq'le yaz */
function moveItems(fromUid, toUid, moves) {
  db.exec("BEGIN");
  try {
    let fromSeq = (db.prepare("SELECT seq FROM meta WHERE user_id=?").get(fromUid) || { seq: 0 }).seq;
    let toSeq = (db.prepare("SELECT seq FROM meta WHERE user_id=?").get(toUid) || { seq: 0 }).seq;
    const now = Date.now();
    const del = db.prepare("UPDATE items SET deleted=1, json=NULL, updated=?, seq=? WHERE user_id=? AND kind=? AND id=? AND deleted=0");
    const ins = db.prepare(`INSERT INTO items(user_id,kind,id,updated,deleted,seq,json) VALUES(?,?,?,?,0,?,?)
      ON CONFLICT(user_id,kind,id) DO UPDATE SET updated=excluded.updated,deleted=0,seq=excluded.seq,json=excluded.json`);
    for (const m of moves) {
      fromSeq++; del.run(now, fromSeq, fromUid, m.kind, m.id); deindexFts(fromUid, m.kind, m.id);
      toSeq++; ins.run(toUid, m.kind, m.id, now, toSeq, JSON.stringify(m.obj)); indexFts(toUid, m.kind, m.id, m.obj);
    }
    db.prepare("INSERT INTO meta(user_id,seq) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET seq=excluded.seq").run(fromUid, fromSeq);
    db.prepare("INSERT INTO meta(user_id,seq) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET seq=excluded.seq").run(toUid, toSeq);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
function listItems(uid, kind) {
  return db.prepare("SELECT json FROM items WHERE user_id=? AND kind=? AND deleted=0 ORDER BY rowid").all(uid, kind).map(r => JSON.parse(r.json));
}
function getItemJson(uid, kind, id) {
  const row = db.prepare("SELECT json FROM items WHERE user_id=? AND kind=? AND id=? AND deleted=0").get(uid, kind, id);
  return row ? JSON.parse(row.json) : null;
}

/* ── MCP: statik API key ya da OAuth access token ile kimlik doğrulama → login_id döner ── */
function authMcp(req) {
  const auth = req.headers["authorization"] || "";
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  if (!m) return null;
  const hash = crypto.createHash("sha256").update(m[1]).digest("hex");
  const key = db.prepare("SELECT login_id FROM api_keys WHERE key_hash=?").get(hash);
  if (key && key.login_id) { db.prepare("UPDATE api_keys SET last_used=? WHERE key_hash=?").run(Date.now(), hash); return key.login_id; }
  const tok = db.prepare("SELECT login_id, expires FROM oauth_tokens WHERE token_hash=? AND kind='access'").get(hash);
  if (tok && (!tok.expires || tok.expires > Date.now())) return tok.login_id;
  return null;
}

/* ── MCP: blok metni <-> düz metin ── */
const stripHtml = s => String(s || "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
function noteToText(n) {
  return (n.blocks || []).map(b => {
    const t = stripHtml(b.html);
    if (b.type === "todo") return (b.checked ? "[x] " : "[ ] ") + t;
    if (b.type === "bullet") return "- " + t;
    return t;
  }).join("\n");
}
function textToBlocks(text) {
  const lines = String(text ?? "").split("\n");
  if (!lines.length) return [{ id: crypto.randomUUID(), type: "p", html: "" }];
  return lines.map(line => {
    const id = crypto.randomUUID();
    let m;
    if ((m = /^\[( |x|X)\]\s?(.*)$/.exec(line))) return { id, type: "todo", checked: m[1].toLowerCase() === "x", html: escHtml(m[2]) };
    if ((m = /^-\s?(.*)$/.exec(line))) return { id, type: "bullet", html: escHtml(m[1]) };
    return { id, type: "p", html: escHtml(line) };
  });
}
function noteSummary(n) {
  return { id: n.id, title: n.title || "", type: n.type || "note", pinned: !!n.pinned, folderId: n.folderId || null, created: n.created, updated: n.updated, preview: noteToText(n).slice(0, 140) };
}

/* ── MCP: araç tanımları ve çalıştırıcılar ── */
const PROJECT_PROP = { type: "string", description: "Proje id'si veya adı (verilmezse varsayılan/ilk proje kullanılır). Kullanılabilir projeler için list_projects çağır." };
const MCP_TOOLS = [
  { name: "list_projects", description: "Bu hesaba bağlı projeleri (ayrı not/görev alanları) listeler.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "list_notes", description: "Bir projedeki tüm notları (başlık, önizleme, klasör) listeler.", inputSchema: { type: "object", properties: { project: PROJECT_PROP }, additionalProperties: false } },
  { name: "get_note", description: "Bir notun tam içeriğini (düz metin olarak) getirir.", inputSchema: { type: "object", properties: { id: { type: "string" }, project: PROJECT_PROP }, required: ["id"], additionalProperties: false } },
  { name: "create_note", description: "Yeni bir not oluşturur.", inputSchema: { type: "object", properties: { title: { type: "string" }, content: { type: "string", description: "Düz metin; '- ' ile başlayan satırlar madde, '[ ] '/'[x] ' ile başlayanlar yapılacak olarak işlenir" }, folderId: { type: "string" }, project: PROJECT_PROP }, required: ["title"], additionalProperties: false } },
  { name: "update_note", description: "Mevcut bir notu günceller (verilmeyen alanlar değişmez).", inputSchema: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, content: { type: "string" }, folderId: { type: "string" }, pinned: { type: "boolean" }, project: PROJECT_PROP }, required: ["id"], additionalProperties: false } },
  { name: "delete_note", description: "Bir notu siler.", inputSchema: { type: "object", properties: { id: { type: "string" }, project: PROJECT_PROP }, required: ["id"], additionalProperties: false } },
  { name: "list_tasks", description: "Bir projedeki tüm görevleri listeler.", inputSchema: { type: "object", properties: { project: PROJECT_PROP }, additionalProperties: false } },
  { name: "create_task", description: "Yeni bir görev oluşturur.", inputSchema: { type: "object", properties: { text: { type: "string" }, desc: { type: "string" }, due: { type: "number", description: "unix ms, opsiyonel" }, project: PROJECT_PROP }, required: ["text"], additionalProperties: false } },
  { name: "update_task", description: "Mevcut bir görevi günceller (verilmeyen alanlar değişmez).", inputSchema: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, desc: { type: "string" }, done: { type: "boolean" }, due: { type: "number" }, project: PROJECT_PROP }, required: ["id"], additionalProperties: false } },
  { name: "delete_task", description: "Bir görevi siler.", inputSchema: { type: "object", properties: { id: { type: "string" }, project: PROJECT_PROP }, required: ["id"], additionalProperties: false } },
  { name: "list_folders", description: "Bir projedeki tüm klasörleri listeler.", inputSchema: { type: "object", properties: { project: PROJECT_PROP }, additionalProperties: false } },
  { name: "create_folder", description: "Yeni bir klasör oluşturur.", inputSchema: { type: "object", properties: { name: { type: "string" }, project: PROJECT_PROP }, required: ["name"], additionalProperties: false } },
];
function mcpCall(loginId, name, args) {
  args = args || {};
  const now = Date.now();
  if (name === "list_projects") return projectsForLogin(loginId).map(p => ({ id: p.id, name: p.name || p.id }));
  const uid = resolveProject(loginId, args.project);
  switch (name) {
    case "list_notes": return listItems(uid, "note").map(noteSummary);
    case "get_note": {
      const n = getItemJson(uid, "note", String(args.id || ""));
      if (!n) throw new Error("not bulunamadı");
      return { id: n.id, title: n.title || "", type: n.type || "note", pinned: !!n.pinned, folderId: n.folderId || null, created: n.created, updated: n.updated, content: noteToText(n) };
    }
    case "create_note": {
      const id = crypto.randomUUID();
      const n = { id, title: String(args.title || ""), type: "note", pinned: false, folderId: args.folderId || null, created: now, updated: now, blocks: textToBlocks(args.content || "") };
      upsertItem(uid, "note", id, n, now);
      return { id };
    }
    case "update_note": {
      const n = getItemJson(uid, "note", String(args.id || ""));
      if (!n) throw new Error("not bulunamadı");
      if (args.title !== undefined) n.title = String(args.title);
      if (args.content !== undefined) n.blocks = textToBlocks(args.content);
      if (args.folderId !== undefined) n.folderId = args.folderId;
      if (args.pinned !== undefined) n.pinned = !!args.pinned;
      n.updated = now;
      upsertItem(uid, "note", n.id, n, now);
      return { ok: true };
    }
    case "delete_note": {
      if (!deleteItem(uid, "note", String(args.id || ""))) throw new Error("not bulunamadı");
      return { ok: true };
    }
    case "list_tasks": return listItems(uid, "task");
    case "create_task": {
      const id = crypto.randomUUID();
      const t = { id, text: String(args.text || ""), desc: args.desc || "", done: false, due: args.due || null, remind: !!args.due, notified: false, created: now, updated: now };
      upsertItem(uid, "task", id, t, now);
      return { id };
    }
    case "update_task": {
      const t = getItemJson(uid, "task", String(args.id || ""));
      if (!t) throw new Error("görev bulunamadı");
      if (args.text !== undefined) t.text = String(args.text);
      if (args.desc !== undefined) t.desc = String(args.desc);
      if (args.done !== undefined) t.done = !!args.done;
      if (args.due !== undefined) t.due = args.due;
      t.updated = now;
      upsertItem(uid, "task", t.id, t, now);
      return { ok: true };
    }
    case "delete_task": {
      if (!deleteItem(uid, "task", String(args.id || ""))) throw new Error("görev bulunamadı");
      return { ok: true };
    }
    case "list_folders": return listItems(uid, "folder");
    case "create_folder": {
      const id = crypto.randomUUID();
      const f = { id, name: String(args.name || ""), created: now, updated: now };
      upsertItem(uid, "folder", id, f, now);
      return { id };
    }
    default: throw new Error("bilinmeyen araç: " + name);
  }
}
function mcpRespond(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "X-Robots-Tag": "noindex" });
  res.end(JSON.stringify(obj));
}
async function handleMcp(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST", "Content-Type": "text/plain" });
    res.end("Method Not Allowed — bu MCP sunucusu yalnızca POST (Streamable HTTP, SSE'siz) destekler");
    return;
  }
  let msg;
  try { msg = JSON.parse(await readBody(req)); } catch { mcpRespond(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Geçersiz JSON" } }); return; }
  const { id = null, method, params } = msg || {};
  const isNotification = id === null && method && method.startsWith("notifications/");
  const reply = result => mcpRespond(res, 200, { jsonrpc: "2.0", id, result });
  const replyErr = (code, message) => mcpRespond(res, 200, { jsonrpc: "2.0", id, error: { code, message } });

  if (method === "initialize") {
    reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "defter", version: "1.0.0" } });
    return;
  }
  if (isNotification) { res.writeHead(202); res.end(); return; }
  if (method === "ping") { reply({}); return; }

  const loginId = authMcp(req);
  if (!loginId) {
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${APP_URL}/.well-known/oauth-protected-resource"`
    });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32001, message: "Yetkisiz — geçerli bir Bearer token gönder" } }));
    return;
  }

  if (method === "tools/list") { reply({ tools: MCP_TOOLS }); return; }
  if (method === "tools/call") {
    try {
      const out = mcpCall(loginId, params && params.name, params && params.arguments);
      reply({ content: [{ type: "text", text: JSON.stringify(out) }] });
    } catch (e) {
      reply({ content: [{ type: "text", text: e.message }], isError: true });
    }
    return;
  }
  replyErr(-32601, "Bilinmeyen method: " + method);
}

/* ── OAuth 2.1 + PKCE + Dinamik İstemci Kaydı (claude.ai custom connector için) ── */
function issueToken(clientId, loginId, kind, ttlMs) {
  const tok = "dfo_" + crypto.randomBytes(32).toString("base64url");
  const hash = crypto.createHash("sha256").update(tok).digest("hex");
  db.prepare("INSERT INTO oauth_tokens(token_hash,client_id,login_id,kind,expires,created) VALUES(?,?,?,?,?,?)")
    .run(hash, clientId, loginId, kind, ttlMs ? Date.now() + ttlMs : null, Date.now());
  return tok;
}
/* süresi dolan/kullanılmış OAuth ve parola-sıfırlama kayıtlarını temizle — tablo büyümesini sınırlar */
function cleanupOauth() {
  const now = Date.now();
  db.prepare("DELETE FROM oauth_tokens WHERE expires IS NOT NULL AND expires < ?").run(now);
  db.prepare("DELETE FROM oauth_codes WHERE used=1 OR expires < ?").run(now);
  db.prepare("DELETE FROM password_resets WHERE used=1 OR expires < ?").run(now);
}
cleanupOauth(); // açılışta bir kez; sonrasında her /token isteğinde
function parseForm(s) { return Object.fromEntries(new URLSearchParams(s)); }
function authRedirectError(res, redirectUri, state, error, desc) {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  if (desc) u.searchParams.set("error_description", desc);
  if (state) u.searchParams.set("state", state);
  res.writeHead(302, { Location: u.toString() }); res.end();
}
function renderConsentPage(clientName, email, q) {
  return `<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>defter. — erişim izni</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,Roboto,sans-serif;min-height:100vh;display:grid;place-items:center;
  background:linear-gradient(130deg,#faf6ec 0%,#f9f2e9 32%,#eff5f0 66%,#f8f4e9 100%);color:#3a413c;-webkit-font-smoothing:antialiased}
.card{width:340px;max-width:90vw;text-align:center;padding:34px 28px;border-radius:22px;background:rgba(255,253,247,.8);
  backdrop-filter:blur(24px) saturate(135%);border:1px solid rgba(255,255,255,.72);box-shadow:0 24px 60px rgba(110,120,105,.14),0 4px 16px rgba(110,120,105,.08)}
.logo{width:52px;height:52px;border-radius:16px;background:linear-gradient(135deg,#71b8a5,#4f9d8b);margin:0 auto 14px;
  display:grid;place-items:center;box-shadow:0 8px 20px rgba(95,150,130,.3)}
.logo svg{width:26px;height:26px;stroke:#fff}
h1{font-size:19px;letter-spacing:-.3px;margin-bottom:4px}
h1 i{color:#4f9d8b;font-style:normal}
p{font-size:13px;color:#5f6a62;margin-bottom:6px;line-height:1.5}
.who{font-size:12.5px;color:#98a099;margin-bottom:20px}
button{width:100%;margin-top:10px;padding:11px;border:none;border-radius:12px;cursor:pointer;font:inherit;font-weight:600;font-size:14.5px}
.approve{background:#39403b;color:#f7f5ec}
.approve:hover{filter:brightness(1.1)}
.deny{background:transparent;color:#98a099;margin-top:6px}
.deny:hover{color:#cf6a5e}
@media (prefers-color-scheme: dark){
  body{background:linear-gradient(130deg,#242923 0%,#2a2e26 34%,#20302a 68%,#282c22 100%);color:#e9ebe4}
  .card{background:rgba(46,52,46,.75);border-color:rgba(255,255,255,.12);box-shadow:0 24px 60px rgba(0,0,0,.4)}
  p{color:#b6beb2} .who{color:#8b948a}
  .approve{background:#e4e6de;color:#2b302b}
}
</style></head><body>
<div class="card">
  <div class="logo"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg></div>
  <h1>defter<i>.</i></h1>
  <p><b>${escHtml(clientName)}</b> notlarına ve görevlerine erişim istiyor.</p>
  <div class="who">${escHtml(email)} olarak giriş yaptın</div>
  <button class="approve" id="approve">İzin ver</button>
  <button class="deny" id="deny">İptal</button>
</div>
<script>
const q = ${JSON.stringify(q).replace(/</g, "\\u003c")};
async function decide(approve) {
  const r = await fetch("/authorize/decision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...q, approve }) });
  const j = await r.json().catch(() => ({}));
  if (j.redirect) location.href = j.redirect; else document.body.innerHTML = "<p style='padding:40px;text-align:center'>Bir hata oluştu.</p>";
}
document.getElementById("approve").onclick = () => decide(true);
document.getElementById("deny").onclick = () => decide(false);
</script>
</body></html>`;
}

migrate();
backfillFts();

/* ── komut satırı yönetimi: node server.js user-add|user-pass <email> <parola> ── */
if (process.argv[2] === "user-add" || process.argv[2] === "user-pass") {
  const [, , cmd, email, pass] = process.argv;
  if (!email || !pass) { console.error("kullanım: node server.js " + cmd + " <email> <parola>"); process.exit(1); }
  if (cmd === "user-add") {
    let id = crypto.randomUUID().slice(0, 8);
    db.prepare("INSERT INTO users(id,email,pass_hash,created) VALUES(?,?,?,?)")
      .run(id, email.toLowerCase(), makeHash(pass), Date.now());
    console.log("kullanıcı eklendi: " + email);
  } else {
    const r = db.prepare("UPDATE users SET pass_hash=?, session_version=session_version+1 WHERE email=?").run(makeHash(pass), email.toLowerCase());
    console.log(r.changes ? "parola güncellendi (tüm oturumlar kapatıldı): " + email : "kullanıcı bulunamadı: " + email);
  }
  process.exit(0);
}

/* ── komut satırı yönetimi: tek-login/çoklu-proje kurulumu ── */
if (process.argv[2] === "login-add") {
  const [, , , email, pass] = process.argv;
  if (!email || !pass) { console.error("kullanım: node server.js login-add <email> <parola>"); process.exit(1); }
  const id = crypto.randomUUID().slice(0, 8);
  db.prepare("INSERT INTO logins(id,email,pass_hash,created) VALUES(?,?,?,?)").run(id, email.toLowerCase(), makeHash(pass), Date.now());
  console.log("login oluşturuldu: " + email + " (id=" + id + ")");
  process.exit(0);
}
if (process.argv[2] === "login-adopt") {
  // mevcut bir projenin parolasını yeni bir login'e taşır (düz metin parolaya gerek kalmadan) ve o projeyi bu login'e bağlar
  const [, , , email, projectId] = process.argv;
  if (!email || !projectId) { console.error("kullanım: node server.js login-adopt <email> <proje_id>"); process.exit(1); }
  const proj = db.prepare("SELECT * FROM users WHERE id=?").get(projectId);
  if (!proj) { console.error("proje bulunamadı: " + projectId); process.exit(1); }
  const id = crypto.randomUUID().slice(0, 8);
  db.prepare("INSERT INTO logins(id,email,pass_hash,created) VALUES(?,?,?,?)").run(id, email.toLowerCase(), proj.pass_hash, Date.now());
  db.prepare("UPDATE users SET login_id=?, name=COALESCE(name, id) WHERE id=?").run(id, projectId);
  console.log("login oluşturuldu (" + email + ") ve proje bağlandı: " + projectId);
  process.exit(0);
}
if (process.argv[2] === "project-link") {
  const [, , , projectId, email, name] = process.argv;
  if (!projectId || !email) { console.error("kullanım: node server.js project-link <proje_id> <login_email> [proje_adı]"); process.exit(1); }
  const login = db.prepare("SELECT * FROM logins WHERE email=?").get(email.toLowerCase());
  if (!login) { console.error("login bulunamadı: " + email); process.exit(1); }
  const proj = db.prepare("SELECT * FROM users WHERE id=?").get(projectId);
  if (!proj) { console.error("proje bulunamadı: " + projectId); process.exit(1); }
  db.prepare("UPDATE users SET login_id=?, name=? WHERE id=?").run(login.id, name || projectId, projectId);
  console.log("proje bağlandı: " + projectId + " → " + email);
  process.exit(0);
}

/* ── komut satırı yönetimi: MCP API key'leri (login'e bağlıdır, tüm projelere erişir) ── */
if (process.argv[2] === "mcp-key-add") {
  const [, , , email, label] = process.argv;
  if (!email) { console.error("kullanım: node server.js mcp-key-add <login_email> [etiket]"); process.exit(1); }
  const login = db.prepare("SELECT * FROM logins WHERE email=?").get(email.toLowerCase());
  if (!login) { console.error("login bulunamadı: " + email); process.exit(1); }
  const key = "dft_" + crypto.randomBytes(24).toString("base64url");
  const hash = crypto.createHash("sha256").update(key).digest("hex");
  db.prepare("INSERT INTO api_keys(key_hash,login_id,label,created) VALUES(?,?,?,?)").run(hash, login.id, label || null, Date.now());
  console.log("API key oluşturuldu (bir daha gösterilmeyecek, güvenli bir yere kaydet):\n" + key);
  process.exit(0);
}
if (process.argv[2] === "mcp-key-list") {
  const [, , , email] = process.argv;
  if (!email) { console.error("kullanım: node server.js mcp-key-list <login_email>"); process.exit(1); }
  const login = db.prepare("SELECT * FROM logins WHERE email=?").get(email.toLowerCase());
  if (!login) { console.error("login bulunamadı: " + email); process.exit(1); }
  const rows = db.prepare("SELECT key_hash,label,created,last_used FROM api_keys WHERE login_id=?").all(login.id);
  if (!rows.length) console.log("kayıtlı API key yok");
  for (const r of rows) console.log(`${r.key_hash.slice(0, 12)}…  etiket=${r.label || "-"}  oluşturuldu=${new Date(r.created).toISOString()}  son kullanım=${r.last_used ? new Date(r.last_used).toISOString() : "-"}`);
  process.exit(0);
}
if (process.argv[2] === "mcp-key-revoke") {
  const [, , , keyPrefix] = process.argv;
  if (!keyPrefix || keyPrefix.length < 12) { console.error("kullanım: node server.js mcp-key-revoke <key_hash başı, en az 12 karakter>"); process.exit(1); }
  const rows = db.prepare("SELECT key_hash FROM api_keys").all().filter(r => r.key_hash.startsWith(keyPrefix));
  if (rows.length !== 1) { console.error(rows.length ? "birden fazla eşleşme, daha uzun bir önek ver" : "eşleşme yok"); process.exit(1); }
  db.prepare("DELETE FROM api_keys WHERE key_hash=?").run(rows[0].key_hash);
  console.log("API key iptal edildi");
  process.exit(0);
}

const INDEX_TPL = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
const LOGIN = fs.readFileSync(path.join(__dirname, "public", "login.html"));
const RESET_PAGE = fs.readFileSync(path.join(__dirname, "public", "reset.html"));
/* JS string literal olarak güvenli göm: JSON.stringify "</script>" dizisini kaçırmaz (script
   bloğundan kaçışa izin verir) ve String.replace "$&" gibi kalıpları işler — ikisine de kapalı */
const jsStr = v => JSON.stringify(String(v)).replace(/</g, "\\u003c");
const renderIndex = project => INDEX_TPL
  .split('"__UID__"').join(jsStr(project.id))
  .split('"__EMAIL__"').join(jsStr((loginOf(project) || project).email))
  .split('"__PROJECT__"').join(jsStr(project.name || project.id));

/* ── e-posta (Resend REST API, npm bağımlılığı yok) ── */
const escHtml = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function sendMail(to, subject, html) {
  if (!RESEND_API_KEY) { console.log("(RESEND_API_KEY yok, mail atlanıyor) →", to, subject); return Promise.resolve(); }
  const payload = JSON.stringify({ from: MAIL_FROM, to: [to], subject, html });
  return new Promise(resolve => {
    const req = https.request({
      hostname: "api.resend.com", path: "/emails", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), "Authorization": "Bearer " + RESEND_API_KEY }
    }, r => { r.on("data", () => {}); r.on("end", resolve); });
    req.on("error", e => { console.error("mail hatası:", e.message); resolve(); });
    req.write(payload); req.end();
  });
}
const emailShell = body => `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;color:#3a413c">
<div style="width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,#71b8a5,#4f9d8b);margin-bottom:14px"></div>
<h2 style="margin:0 0 14px;font-size:18px">defter<span style="color:#4f9d8b">.</span></h2>
${body}
<p style="color:#98a099;font-size:12px;margin-top:24px">Bu otomatik bir bildirimdir, yanıtlamayın.</p>
</div>`;
const forgotHtml = link => emailShell(`
<p style="font-size:14px;line-height:1.6">Parolanı sıfırlamak için aşağıdaki bağlantıya tıkla. Bağlantı <b>30 dakika</b> geçerlidir.</p>
<p><a href="${link}" style="display:inline-block;background:#4f9d8b;color:#fff;padding:10px 20px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px">Parolamı sıfırla</a></p>
<p style="color:#98a099;font-size:12.5px">Bu isteği sen yapmadıysan bu e-postayı yok sayabilirsin, hesabında hiçbir şey değişmez.</p>`);
const passwordChangedHtml = () => emailShell(`
<p style="font-size:14px;line-height:1.6">Hesabının parolası az önce değiştirildi ve tüm cihazlardaki oturumlar kapatıldı.</p>
<p style="color:#98a099;font-size:12.5px">Bu sen değilsen hemen yeni bir parola sıfırlama isteği oluştur.</p>`);
const newDeviceHtml = (ip, ua) => emailShell(`
<p style="font-size:14px;line-height:1.6">Hesabına yeni bir cihaz/tarayıcıdan giriş yapıldı.</p>
<p style="color:#98a099;font-size:12.5px;line-height:1.6">IP: ${escHtml(ip)}<br>Tarayıcı: ${escHtml(ua || "bilinmiyor")}</p>
<p style="font-size:13.5px">Bu sen değilsen parolanı hemen değiştir (bu, tüm cihazlardaki oturumları kapatır).</p>`);

/* ── oturum ── */
function sign(payload) {
  const b = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const s = crypto.createHmac("sha256", SECRET).update(b).digest("base64url");
  return b + "." + s;
}
function verifyTok(tok) {
  if (!tok) return null;
  const dot = tok.lastIndexOf(".");
  if (dot < 1) return null;
  const b = tok.slice(0, dot), s = tok.slice(dot + 1);
  const exp = crypto.createHmac("sha256", SECRET).update(b).digest("base64url");
  if (s.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(exp))) return null;
  try {
    const p = JSON.parse(Buffer.from(b, "base64url").toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
function getCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return part.slice(eq + 1).trim();
  }
  return null;
}
function getCookiesByPrefix(req, prefix) {
  const raw = req.headers.cookie || "";
  const out = [];
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k.startsWith(prefix)) out.push(k.slice(prefix.length));
  }
  return out;
}
/* ── giriş kimliği (login) ↔ proje ── tek login birden fazla projeye (eski "hesap") bağlanabilir */
const loginOf = project => project.login_id ? db.prepare("SELECT * FROM logins WHERE id=?").get(project.login_id) : null;
const projectsForLogin = loginId => db.prepare("SELECT * FROM users WHERE login_id=? ORDER BY created").all(loginId);
// bir kullanıcının en son içerik güncellediği proje — "en eski oluşturulan proje" yerine daha isabetli bir varsayılan aktif proje seçimi için
function mostActiveProject(projects) {
  let best = projects[0], bestTs = -1;
  for (const p of projects) {
    const row = db.prepare("SELECT MAX(updated) t FROM items WHERE user_id=? AND deleted=0").get(p.id);
    const ts = row && row.t || 0;
    if (ts > bestTs) { bestTs = ts; best = p; }
  }
  return best;
}
function resolveProject(loginId, ref) {
  const projects = projectsForLogin(loginId);
  if (!projects.length) throw new Error("bu hesaba bağlı proje yok");
  if (!ref) return mostActiveProject(projects).id;
  const p = projects.find(p => p.id === ref || p.name === ref);
  if (!p) throw new Error("proje bulunamadı: " + ref);
  return p.id;
}

/* çoklu proje oturumu: her proje kendi sid_<uid> cookie'sinde, "active" hangisinin aktif olduğunu tutar.
   Bir projenin oturum geçerliliği, bağlı olduğu login'in session_version'ına göre doğrulanır (varsa);
   login_id henüz atanmamış eski projelerde kendi session_version'ı kullanılır. */
function sessionFor(req, uid) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(uid)) return null;
  const tok = getCookie(req, "sid_" + uid);
  const p = verifyTok(tok);
  if (!p || p.u !== uid) return null;
  const project = db.prepare("SELECT * FROM users WHERE id=?").get(uid);
  if (!project) return null;
  const login = loginOf(project);
  const version = login ? login.session_version : project.session_version;
  if (version !== p.v) return null;
  return project;
}
function activeUid(req) { return getCookie(req, "active"); }
function authedUser(req) {
  const uid = activeUid(req);
  return uid ? sessionFor(req, uid) : null;
}
function listSessions(req) {
  const out = [];
  for (const uid of getCookiesByPrefix(req, "sid_")) {
    const u = sessionFor(req, uid);
    if (u) out.push({ id: u.id, name: u.name || u.id, email: (loginOf(u) || u).email });
  }
  return out;
}
const sessionCookie = (uid, tok) => `sid_${uid}=${tok}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MS / 1000}`;
const clearSessionCookie = uid => `sid_${uid}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
const activeCookie = uid => `active=${uid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MS / 1000}`;
const clearActiveCookie = "active=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
const deviceCookie = id => `did=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DEVICE_MS / 1000}`;

/* ── giriş denemesi sınırı ── */
const attempts = new Map();
function limited(ip) {
  const now = Date.now();
  const a = attempts.get(ip) || { n: 0, t: now };
  if (now - a.t > 60_000) { a.n = 0; a.t = now; }
  a.n++;
  attempts.set(ip, a);
  if (attempts.size > 5000) { for (const [k, v] of attempts) if (now - v.t > 60_000) attempts.delete(k); }
  return a.n > 10;
}

/* ── http yardımcıları ── */
function readBody(req) {
  return new Promise((res, rej) => {
    let size = 0; const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BODY) { rej(new Error("büyük")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => res(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rej);
  });
}
function readBodyBuffer(req) {
  return new Promise((res, rej) => {
    let size = 0; const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BODY) { rej(new Error("büyük")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => res(Buffer.concat(chunks)));
    req.on("error", rej);
  });
}
function json(res, code, obj, headers = {}) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "X-Robots-Tag": "noindex", ...headers });
  res.end(JSON.stringify(obj));
}
function html(res, code, body, headers = {}) {
  res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "X-Robots-Tag": "noindex", ...headers });
  res.end(body);
}

/* ── sunucu ── */
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const ip = req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "?";

  try {
    if (p === "/healthz") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("ok"); return; }

    if (p === "/mcp") { await handleMcp(req, res); return; }

    if (p === "/.well-known/oauth-protected-resource") {
      json(res, 200, { resource: APP_URL + "/mcp", authorization_servers: [APP_URL] });
      return;
    }
    if (p === "/.well-known/oauth-authorization-server") {
      json(res, 200, {
        issuer: APP_URL,
        authorization_endpoint: APP_URL + "/authorize",
        token_endpoint: APP_URL + "/token",
        registration_endpoint: APP_URL + "/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
      return;
    }

    if (p === "/register" && req.method === "POST") {
      if (limited(ip)) { json(res, 429, { error: "slow_down" }); return; }
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: "invalid_client_metadata" }); return; }
      const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter(u => typeof u === "string" && /^https?:\/\//.test(u)) : [];
      if (!uris.length) { json(res, 400, { error: "invalid_redirect_uri" }); return; }
      const clientId = crypto.randomUUID();
      const clientName = String(body.client_name || "MCP Client").slice(0, 120);
      db.prepare("INSERT INTO oauth_clients(client_id,redirect_uris,client_name,created) VALUES(?,?,?,?)")
        .run(clientId, JSON.stringify(uris), clientName, Date.now());
      json(res, 201, {
        client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: uris, client_name: clientName, token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      });
      return;
    }

    if (p === "/authorize") {
      const q = url.searchParams;
      const clientId = q.get("client_id"), redirectUri = q.get("redirect_uri");
      const responseType = q.get("response_type"), state = q.get("state") || "";
      const codeChallenge = q.get("code_challenge"), codeChallengeMethod = q.get("code_challenge_method") || "";
      const client = clientId && db.prepare("SELECT * FROM oauth_clients WHERE client_id=?").get(clientId);
      if (!client) { html(res, 400, "<p>Geçersiz client_id</p>"); return; }
      const redirectUris = JSON.parse(client.redirect_uris);
      if (!redirectUri || !redirectUris.includes(redirectUri)) { html(res, 400, "<p>Geçersiz redirect_uri</p>"); return; }
      if (responseType !== "code") { authRedirectError(res, redirectUri, state, "unsupported_response_type"); return; }
      if (!codeChallenge || codeChallengeMethod !== "S256") { authRedirectError(res, redirectUri, state, "invalid_request", "PKCE (S256) zorunlu"); return; }

      const project = authedUser(req);
      if (!project) { res.writeHead(302, { Location: "/login?return=" + encodeURIComponent(req.url) }); res.end(); return; }
      const identity = loginOf(project) || project;

      if (req.method === "GET") {
        html(res, 200, renderConsentPage(client.client_name || client.client_id, identity.email, {
          client_id: clientId, redirect_uri: redirectUri, state, code_challenge: codeChallenge, code_challenge_method: codeChallengeMethod,
        }));
        return;
      }
    }

    if (p === "/authorize/decision" && req.method === "POST") {
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: "invalid_request" }); return; }
      const { client_id: clientId, redirect_uri: redirectUri, state = "", code_challenge: codeChallenge, code_challenge_method: codeChallengeMethod, approve } = body;
      const client = clientId && db.prepare("SELECT * FROM oauth_clients WHERE client_id=?").get(clientId);
      if (!client) { json(res, 400, { error: "invalid_client" }); return; }
      const redirectUris = JSON.parse(client.redirect_uris);
      if (!redirectUri || !redirectUris.includes(redirectUri)) { json(res, 400, { error: "invalid_redirect_uri" }); return; }
      if (!codeChallenge || codeChallengeMethod !== "S256") { json(res, 400, { error: "invalid_request" }); return; }
      const project = authedUser(req);
      if (!project) { json(res, 401, { error: "login_required" }); return; }
      if (!approve) {
        const u = new URL(redirectUri); u.searchParams.set("error", "access_denied"); if (state) u.searchParams.set("state", state);
        json(res, 200, { redirect: u.toString() }); return;
      }
      const identity = loginOf(project) || project;
      const loginId = identity.id;
      const code = crypto.randomBytes(32).toString("base64url");
      const codeHash = crypto.createHash("sha256").update(code).digest("hex");
      db.prepare("INSERT INTO oauth_codes(code_hash,client_id,login_id,redirect_uri,code_challenge,expires,used) VALUES(?,?,?,?,?,?,0)")
        .run(codeHash, clientId, loginId, redirectUri, codeChallenge, Date.now() + 5 * 60 * 1000);
      const u = new URL(redirectUri); u.searchParams.set("code", code); if (state) u.searchParams.set("state", state);
      json(res, 200, { redirect: u.toString() });
      return;
    }

    if (p === "/token" && req.method === "POST") {
      if (limited(ip)) { json(res, 429, { error: "slow_down" }); return; }
      cleanupOauth();
      const raw = await readBody(req);
      const ct = req.headers["content-type"] || "";
      let body;
      try { body = ct.includes("application/json") ? JSON.parse(raw || "{}") : parseForm(raw); } catch { json(res, 400, { error: "invalid_request" }); return; }

      // istemci kimliği body'de yoksa HTTP Basic Auth header'ından oku (bazı istemciler public client için de Basic ile client_id gönderir)
      if (!body.client_id) {
        const basic = /^Basic\s+(\S+)$/i.exec(req.headers["authorization"] || "");
        if (basic) { try { body.client_id = Buffer.from(basic[1], "base64").toString().split(":")[0]; } catch {} }
      }

      if (body.grant_type === "authorization_code") {
        const codeHash = crypto.createHash("sha256").update(String(body.code || "")).digest("hex");
        const row = db.prepare("SELECT * FROM oauth_codes WHERE code_hash=?").get(codeHash);
        if (!row || row.used || row.expires < Date.now() || row.client_id !== body.client_id || row.redirect_uri !== body.redirect_uri) {
          json(res, 400, { error: "invalid_grant" }); return;
        }
        const verifier = String(body.code_verifier || "");
        const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
        if (challenge !== row.code_challenge) {
          json(res, 400, { error: "invalid_grant", error_description: "PKCE doğrulaması başarısız" }); return;
        }
        db.prepare("UPDATE oauth_codes SET used=1 WHERE code_hash=?").run(codeHash);
        const access = issueToken(row.client_id, row.login_id, "access", 3600_000);
        const refresh = issueToken(row.client_id, row.login_id, "refresh", null);
        json(res, 200, { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: "" });
        return;
      }
      if (body.grant_type === "refresh_token") {
        const rHash = crypto.createHash("sha256").update(String(body.refresh_token || "")).digest("hex");
        const row = db.prepare("SELECT * FROM oauth_tokens WHERE token_hash=? AND kind='refresh'").get(rHash);
        if (!row || (row.expires && row.expires < Date.now())) { json(res, 400, { error: "invalid_grant" }); return; }
        // refresh token rotation (RFC 9700): eskisi geçersiz kılınıp yenisi verilir —
        // sızmış bir refresh token ikinci kullanımda invalid_grant alır ve fark edilir
        db.prepare("DELETE FROM oauth_tokens WHERE token_hash=?").run(rHash);
        const access = issueToken(row.client_id, row.login_id, "access", 3600_000);
        const refresh = issueToken(row.client_id, row.login_id, "refresh", null);
        json(res, 200, { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: "" });
        return;
      }
      json(res, 400, { error: "unsupported_grant_type" });
      return;
    }

    if (p === "/api/login" && req.method === "POST") {
      if (limited(ip)) { json(res, 429, { error: "Çok fazla deneme — 1 dakika bekle" }); return; }
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch {}
      const email = String(body.email || "").trim().toLowerCase();
      const pass = body.password || "";

      let identityId, identityEmail, cookies, projectIds;
      const login = db.prepare("SELECT * FROM logins WHERE email=?").get(email);
      if (login && verifyHash(login.pass_hash, pass)) {
        const projects = projectsForLogin(login.id);
        if (!projects.length) { json(res, 401, { error: "Bu hesaba bağlı proje yok" }); return; }
        cookies = projects.map(pr => sessionCookie(pr.id, sign({ u: pr.id, v: login.session_version, exp: Date.now() + SESSION_MS })));
        // bu tarayıcıda önceden aktif bırakılmış bir proje varsa onu koru; yoksa en son içerik güncellenen projeye düş
        const prevActive = getCookie(req, "active");
        const activeId = projects.some(pr => pr.id === prevActive) ? prevActive : mostActiveProject(projects).id;
        cookies.push(activeCookie(activeId));
        identityId = login.id; identityEmail = login.email; projectIds = projects.map(p => p.id);
      } else {
        // eski (henüz login'e bağlanmamış) proje: doğrudan kendi parolasıyla giriş
        const user = db.prepare("SELECT * FROM users WHERE email=? AND login_id IS NULL").get(email);
        if (!user || !verifyHash(user.pass_hash, pass)) { json(res, 401, { error: "E-posta ya da parola yanlış" }); return; }
        cookies = [sessionCookie(user.id, sign({ u: user.id, v: user.session_version, exp: Date.now() + SESSION_MS })), activeCookie(user.id)];
        identityId = user.id; identityEmail = user.email; projectIds = [user.id];
      }

      let deviceId = getCookie(req, "did");
      if (!deviceId || !/^[a-f0-9]{32}$/.test(deviceId)) { deviceId = crypto.randomBytes(16).toString("hex"); cookies.push(deviceCookie(deviceId)); }
      const known = db.prepare("SELECT 1 FROM known_devices WHERE user_id=? AND device_id=?").get(identityId, deviceId);
      if (!known) {
        db.prepare("INSERT INTO known_devices(user_id,device_id,created,last_seen) VALUES(?,?,?,?)").run(identityId, deviceId, Date.now(), Date.now());
        sendMail(identityEmail, "defter. — yeni cihazdan giriş", newDeviceHtml(ip, req.headers["user-agent"])).catch(() => {});
      } else {
        db.prepare("UPDATE known_devices SET last_seen=? WHERE user_id=? AND device_id=?").run(Date.now(), identityId, deviceId);
      }

      json(res, 200, { ok: true, email: identityEmail, projects: projectIds }, { "Set-Cookie": cookies });
      return;
    }

    if (p === "/api/logout" && req.method === "POST") {
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch {}
      const cookies = [];
      if (body.all) {
        for (const uid of getCookiesByPrefix(req, "sid_")) cookies.push(clearSessionCookie(uid));
        cookies.push(clearActiveCookie);
      } else {
        const current = activeUid(req);
        const target = body.uid && sessionFor(req, String(body.uid)) ? String(body.uid) : current;
        if (target) {
          cookies.push(clearSessionCookie(target));
          if (target === current) {
            let nextActive = null;
            for (const uid of getCookiesByPrefix(req, "sid_")) {
              if (uid === target) continue;
              if (sessionFor(req, uid)) { nextActive = uid; break; }
            }
            cookies.push(nextActive ? activeCookie(nextActive) : clearActiveCookie);
          }
        }
      }
      json(res, 200, { ok: true }, cookies.length ? { "Set-Cookie": cookies } : {});
      return;
    }

    if (p === "/api/switch" && req.method === "POST") {
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch {}
      const uid = String(body.uid || "");
      const user = sessionFor(req, uid);
      if (!user) { json(res, 401, { error: "Bu hesapla oturum bulunamadı" }); return; }
      json(res, 200, { ok: true, email: (loginOf(user) || user).email }, { "Set-Cookie": [activeCookie(uid)] });
      return;
    }

    if (p === "/api/accounts" && req.method === "GET") {
      json(res, 200, { accounts: listSessions(req), active: activeUid(req) });
      return;
    }

    if (p === "/api/forgot" && req.method === "POST") {
      if (limited(ip)) { json(res, 429, { error: "Çok fazla deneme — 1 dakika bekle" }); return; }
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch {}
      const email = String(body.email || "").trim().toLowerCase();
      const login = db.prepare("SELECT * FROM logins WHERE email=?").get(email);
      const user = !login && db.prepare("SELECT * FROM users WHERE email=? AND login_id IS NULL").get(email);
      const identity = login || user;
      if (identity) {
        const token = crypto.randomBytes(32).toString("base64url");
        const hash = crypto.createHash("sha256").update(token).digest("hex");
        db.prepare("INSERT INTO password_resets(token_hash,user_id,expires,used,kind) VALUES(?,?,?,0,?)").run(hash, identity.id, Date.now() + RESET_MS, login ? "login" : "user");
        sendMail(identity.email, "defter. — parola sıfırlama", forgotHtml(APP_URL + "/reset?token=" + token)).catch(() => {});
      }
      json(res, 200, { ok: true, message: "Eğer bu e-posta kayıtlıysa sıfırlama bağlantısı gönderildi." });
      return;
    }

    if (p === "/reset" && req.method === "GET") { html(res, 200, RESET_PAGE); return; }

    if (p === "/api/reset" && req.method === "POST") {
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: "Geçersiz istek" }); return; }
      const token = String(body.token || "");
      const pass = String(body.password || "");
      if (pass.length < 8) { json(res, 400, { error: "Parola en az 8 karakter olmalı" }); return; }
      const hash = crypto.createHash("sha256").update(token).digest("hex");
      const row = db.prepare("SELECT * FROM password_resets WHERE token_hash=?").get(hash);
      if (!row || row.used || row.expires < Date.now()) { json(res, 400, { error: "Bağlantı geçersiz veya süresi dolmuş" }); return; }
      const identity = row.kind === "login"
        ? db.prepare("SELECT * FROM logins WHERE id=?").get(row.user_id)
        : db.prepare("SELECT * FROM users WHERE id=?").get(row.user_id);
      if (!identity) { json(res, 400, { error: "Bağlantı geçersiz veya süresi dolmuş" }); return; }
      if (row.kind === "login") db.prepare("UPDATE logins SET pass_hash=?, session_version=session_version+1 WHERE id=?").run(makeHash(pass), identity.id);
      else db.prepare("UPDATE users SET pass_hash=?, session_version=session_version+1 WHERE id=?").run(makeHash(pass), identity.id);
      db.prepare("UPDATE password_resets SET used=1 WHERE token_hash=?").run(hash);
      sendMail(identity.email, "defter. — parolan değişti", passwordChangedHtml()).catch(() => {});
      json(res, 200, { ok: true });
      return;
    }

    if (p === "/login") {
      if (authedUser(req) && url.searchParams.get("add") !== "1") { res.writeHead(302, { Location: "/" }); res.end(); return; }
      html(res, 200, LOGIN);
      return;
    }

    if (p.startsWith("/api/")) {
      const user = authedUser(req);
      if (!user) { json(res, 401, { error: "Oturum yok" }); return; }

      if (p === "/api/me" && req.method === "GET") {
        json(res, 200, { id: user.id, name: user.name || user.id, email: (loginOf(user) || user).email });
        return;
      }

      if (p === "/api/password" && req.method === "POST") {
        let body = {};
        try { body = JSON.parse(await readBody(req)); } catch {}
        const login = loginOf(user);
        const identity = login || user;
        if (!verifyHash(identity.pass_hash, body.current || "")) { json(res, 403, { error: "Mevcut parola yanlış" }); return; }
        if (String(body.next || "").length < 8) { json(res, 400, { error: "Yeni parola en az 8 karakter olmalı" }); return; }
        const newVersion = identity.session_version + 1;
        const cookies = [];
        if (login) {
          db.prepare("UPDATE logins SET pass_hash=?, session_version=? WHERE id=?").run(makeHash(body.next), newVersion, login.id);
          for (const pr of projectsForLogin(login.id)) cookies.push(sessionCookie(pr.id, sign({ u: pr.id, v: newVersion, exp: Date.now() + SESSION_MS })));
        } else {
          db.prepare("UPDATE users SET pass_hash=?, session_version=? WHERE id=?").run(makeHash(body.next), newVersion, user.id);
          cookies.push(sessionCookie(user.id, sign({ u: user.id, v: newVersion, exp: Date.now() + SESSION_MS })));
        }
        sendMail(identity.email, "defter. — parolan değişti", passwordChangedHtml()).catch(() => {});
        json(res, 200, { ok: true }, { "Set-Cookie": cookies });
        return;
      }

      if (p === "/api/data" && req.method === "GET") {
        json(res, 200, { seq: userSeq(user.id), data: buildState(user.id) });
        return;
      }

      if (p === "/api/search" && req.method === "GET") {
        const q = (url.searchParams.get("q") || "").trim();
        if (!q) { json(res, 200, { results: [] }); return; }
        // her kelimeyi ayrı ayrı tırnaklayıp (FTS5 operatörlerinden — AND/OR/NOT, *, parantez —
        // bağımsız kılar, 500 üretmez) sonuna * ekleyerek prefix aramaya çeviriyoruz: kullanıcı
        // "essiztoken" yazınca "essiztokenaciklamasi" gibi tam kelimeleri de bulabilsin diye.
        // Kelimeler arasında FTS5'in varsayılan (örtük AND) davranışı geçerli.
        const words = q.split(/\s+/).filter(Boolean).slice(0, 8);
        if (!words.length) { json(res, 200, { results: [] }); return; }
        const phrase = words.map(w => '"' + w.replace(/"/g, '""') + '"*').join(" ");
        try {
          const rows = db.prepare(`
            SELECT kind, id, title, snippet(items_fts, 4, '<b>', '</b>', '…', 12) AS snip
            FROM items_fts WHERE user_id=? AND items_fts MATCH ?
            ORDER BY rank LIMIT 20
          `).all(user.id, phrase);
          json(res, 200, { results: rows });
        } catch (e) { json(res, 200, { results: [] }); }
        return;
      }

      if (p === "/api/sync" && req.method === "POST") {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: "Geçersiz JSON" }); return; }
        if (!body || typeof body.data !== "object" || body.data === null) { json(res, 400, { error: "Eksik veri" }); return; }
        const r = syncUser(user.id, Number(body.baseSeq) || 0, body.data);
        json(res, 200, { seq: r.seq, changed: r.changed, data: r.changed ? buildState(user.id) : undefined });
        return;
      }

      if (p === "/api/move" && req.method === "POST") {
        let body = {};
        try { body = JSON.parse(await readBody(req)); } catch {}
        const kind = body.kind, id = String(body.id || "");
        const targetUid = String(body.target || "");
        if (!["note", "folder"].includes(kind) || !id || !targetUid) { json(res, 400, { error: "Eksik parametre" }); return; }
        if (targetUid === user.id) { json(res, 400, { error: "Zaten bu projede" }); return; }
        if (!sessionFor(req, targetUid)) { json(res, 403, { error: "Hedef projeye erişimin yok" }); return; }
        const moves = [];
        if (kind === "note") {
          const row = db.prepare("SELECT json FROM items WHERE user_id=? AND kind='note' AND id=? AND deleted=0").get(user.id, id);
          if (!row) { json(res, 404, { error: "Not bulunamadı" }); return; }
          const note = JSON.parse(row.json);
          note.folderId = null; // klasörler proje bazlı — hedefte aynı klasör yok
          moves.push({ kind: "note", id, obj: note });
        } else {
          const frow = db.prepare("SELECT json FROM items WHERE user_id=? AND kind='folder' AND id=? AND deleted=0").get(user.id, id);
          if (!frow) { json(res, 404, { error: "Klasör bulunamadı" }); return; }
          moves.push({ kind: "folder", id, obj: JSON.parse(frow.json) });
          for (const n of db.prepare("SELECT id,json FROM items WHERE user_id=? AND kind='note' AND deleted=0").all(user.id)) {
            const obj = JSON.parse(n.json);
            if (obj.folderId === id) moves.push({ kind: "note", id: n.id, obj });
          }
        }
        try { moveItems(user.id, targetUid, moves); } catch (e) { json(res, 500, { error: "Taşıma başarısız" }); return; }
        json(res, 200, { ok: true, moved: moves.length });
        return;
      }

      if (p === "/api/stt" && req.method === "POST") {
        if (!STT_WORKER_URL || !STT_WORKER_SECRET) { json(res, 500, { error: "STT yapılandırılmamış" }); return; }
        const lang = url.searchParams.get("lang") || "tr";
        let audio;
        try { audio = await readBodyBuffer(req); } catch { json(res, 400, { error: "Geçersiz ses verisi" }); return; }
        if (!audio.length) { json(res, 400, { error: "Boş ses verisi" }); return; }
        try {
          const r = await fetch(STT_WORKER_URL + "?lang=" + encodeURIComponent(lang), {
            method: "POST",
            headers: { Authorization: "Bearer " + STT_WORKER_SECRET, "Content-Type": "application/octet-stream" },
            body: audio,
          });
          const j = await r.json();
          json(res, r.status, j);
        } catch (e) { json(res, 502, { error: "STT servisine ulaşılamadı" }); }
        return;
      }

      if (p === "/api/summarize" && req.method === "POST") {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: "Geçersiz JSON" }); return; }
        const text = String(body?.text || "").trim();
        if (!text) { json(res, 400, { error: "Boş metin" }); return; }
        if (!STT_WORKER_URL || !STT_WORKER_SECRET) { json(res, 500, { error: "Özetleme yapılandırılmamış" }); return; }
        try {
          const r = await fetch(STT_WORKER_URL + "/summarize", {
            method: "POST",
            headers: { Authorization: "Bearer " + STT_WORKER_SECRET, "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
          });
          const j = await r.json();
          json(res, r.status, j);
        } catch (e) { json(res, 502, { error: "Özetleme servisine ulaşılamadı" }); }
        return;
      }

      json(res, 404, { error: "Yok" });
      return;
    }

    if (p === "/" || /^\/not\/[a-zA-Z0-9_-]+$/.test(p) || p === "/gorevler" || p === "/takvim") {
      const user = authedUser(req);
      if (!user) { res.writeHead(302, { Location: "/login?return=" + encodeURIComponent(p) }); res.end(); return; }
      html(res, 200, renderIndex(user));
      return;
    }

    res.writeHead(302, { Location: "/" });
    res.end();
  } catch (e) {
    console.error(e);
    try { json(res, 500, { error: "Sunucu hatası" }); } catch {}
  }
}).listen(PORT, () => console.log("defter. sunucusu (sqlite, çoklu hesap) :" + PORT));
