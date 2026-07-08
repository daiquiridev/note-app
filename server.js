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
  user_id TEXT NOT NULL,
  label TEXT,
  created INTEGER NOT NULL,
  last_used INTEGER
);`);
/* eski kurulumlardan yükseltme: session_version kolonu yoksa ekle */
try { db.exec("ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0"); } catch {}

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

/* ── senkron çekirdeği ── */
function collectClientItems(data) {
  const out = [];
  for (const n of data.notes || []) out.push({ kind: "note", id: String(n.id), updated: n.updated || 0, json: n });
  for (const t of data.tasks || []) out.push({ kind: "task", id: String(t.id), updated: t.updated || t.created || 0, json: t });
  for (const f of data.folders || []) out.push({ kind: "folder", id: String(f.id), updated: f.updated || f.created || 0, json: f });
  out.push({
    kind: "settings", id: "main", updated: data.mtime || 0,
    json: { theme: data.theme ?? null, accent: data.accent ?? null, pin: data.pin ?? null, collapsed: data.collapsed || [], tracking: data.tracking ?? null }
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
      if (!row || it.updated > row.updated) up.run(uid, it.kind, it.id, it.updated, ++seq, JSON.stringify(it.json));
      else if (row.deleted || row.updated > it.updated) changed = true;   // sunucu tarafı daha yeni → istemci güncellenmeli
    }
    const del = db.prepare("UPDATE items SET deleted=1, json=NULL, updated=?, seq=? WHERE user_id=? AND kind=? AND id=?");
    const now = Date.now();
    for (const [key, row] of rows) {
      if (row.deleted || clientKeys.has(key) || row.kind === "settings") continue;
      if (row.seq <= baseSeq) del.run(now, ++seq, uid, row.kind, row.id); // istemci biliyordu ve silmiş → tombstone
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
  const s = { notes: [], tasks: [], folders: [], theme: null, accent: null, pin: null, collapsed: [], mtime: 0 };
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
    if (r.changes) db.prepare("INSERT INTO meta(user_id,seq) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET seq=excluded.seq").run(uid, seq);
    db.exec("COMMIT");
    return !!r.changes;
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
function listItems(uid, kind) {
  return db.prepare("SELECT json FROM items WHERE user_id=? AND kind=? AND deleted=0 ORDER BY rowid").all(uid, kind).map(r => JSON.parse(r.json));
}
function getItemJson(uid, kind, id) {
  const row = db.prepare("SELECT json FROM items WHERE user_id=? AND kind=? AND id=? AND deleted=0").get(uid, kind, id);
  return row ? JSON.parse(row.json) : null;
}

/* ── MCP: API key ile kimlik doğrulama ── */
function authMcp(req) {
  const auth = req.headers["authorization"] || "";
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  if (!m) return null;
  const hash = crypto.createHash("sha256").update(m[1]).digest("hex");
  const row = db.prepare("SELECT * FROM api_keys WHERE key_hash=?").get(hash);
  if (!row) return null;
  db.prepare("UPDATE api_keys SET last_used=? WHERE key_hash=?").run(Date.now(), hash);
  return db.prepare("SELECT * FROM users WHERE id=?").get(row.user_id) || null;
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
const MCP_TOOLS = [
  { name: "list_notes", description: "Kullanıcının tüm notlarını (başlık, önizleme, klasör) listeler.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_note", description: "Bir notun tam içeriğini (düz metin olarak) getirir.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
  { name: "create_note", description: "Yeni bir not oluşturur.", inputSchema: { type: "object", properties: { title: { type: "string" }, content: { type: "string", description: "Düz metin; '- ' ile başlayan satırlar madde, '[ ] '/'[x] ' ile başlayanlar yapılacak olarak işlenir" }, folderId: { type: "string" } }, required: ["title"], additionalProperties: false } },
  { name: "update_note", description: "Mevcut bir notu günceller (verilmeyen alanlar değişmez).", inputSchema: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, content: { type: "string" }, folderId: { type: "string" }, pinned: { type: "boolean" } }, required: ["id"], additionalProperties: false } },
  { name: "delete_note", description: "Bir notu siler.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
  { name: "list_tasks", description: "Kullanıcının tüm görevlerini listeler.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "create_task", description: "Yeni bir görev oluşturur.", inputSchema: { type: "object", properties: { text: { type: "string" }, desc: { type: "string" }, due: { type: "number", description: "unix ms, opsiyonel" } }, required: ["text"], additionalProperties: false } },
  { name: "update_task", description: "Mevcut bir görevi günceller (verilmeyen alanlar değişmez).", inputSchema: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, desc: { type: "string" }, done: { type: "boolean" }, due: { type: "number" } }, required: ["id"], additionalProperties: false } },
  { name: "delete_task", description: "Bir görevi siler.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
  { name: "list_folders", description: "Kullanıcının tüm klasörlerini listeler.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "create_folder", description: "Yeni bir klasör oluşturur.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } },
];
function mcpCall(uid, name, args) {
  args = args || {};
  const now = Date.now();
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

  const user = authMcp(req);
  if (!user) { replyErr(-32001, "Yetkisiz — geçerli bir API key ile Authorization: Bearer <key> gönder"); return; }

  if (method === "tools/list") { reply({ tools: MCP_TOOLS }); return; }
  if (method === "tools/call") {
    try {
      const out = mcpCall(user.id, params && params.name, params && params.arguments);
      reply({ content: [{ type: "text", text: JSON.stringify(out) }] });
    } catch (e) {
      reply({ content: [{ type: "text", text: e.message }], isError: true });
    }
    return;
  }
  replyErr(-32601, "Bilinmeyen method: " + method);
}

migrate();

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

/* ── komut satırı yönetimi: MCP API key'leri ── */
if (process.argv[2] === "mcp-key-add") {
  const [, , , email, label] = process.argv;
  if (!email) { console.error("kullanım: node server.js mcp-key-add <email> [etiket]"); process.exit(1); }
  const user = db.prepare("SELECT * FROM users WHERE email=?").get(email.toLowerCase());
  if (!user) { console.error("kullanıcı bulunamadı: " + email); process.exit(1); }
  const key = "dft_" + crypto.randomBytes(24).toString("base64url");
  const hash = crypto.createHash("sha256").update(key).digest("hex");
  db.prepare("INSERT INTO api_keys(key_hash,user_id,label,created) VALUES(?,?,?,?)").run(hash, user.id, label || null, Date.now());
  console.log("API key oluşturuldu (bir daha gösterilmeyecek, güvenli bir yere kaydet):\n" + key);
  process.exit(0);
}
if (process.argv[2] === "mcp-key-list") {
  const [, , , email] = process.argv;
  if (!email) { console.error("kullanım: node server.js mcp-key-list <email>"); process.exit(1); }
  const user = db.prepare("SELECT * FROM users WHERE email=?").get(email.toLowerCase());
  if (!user) { console.error("kullanıcı bulunamadı: " + email); process.exit(1); }
  const rows = db.prepare("SELECT key_hash,label,created,last_used FROM api_keys WHERE user_id=?").all(user.id);
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
const renderIndex = user => INDEX_TPL.replace('"__UID__"', JSON.stringify(user.id)).replace('"__EMAIL__"', JSON.stringify(user.email));

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
/* çoklu hesap oturumu: her hesap kendi sid_<uid> cookie'sinde, "active" hangisinin aktif olduğunu tutar */
function sessionFor(req, uid) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(uid)) return null;
  const tok = getCookie(req, "sid_" + uid);
  const p = verifyTok(tok);
  if (!p || p.u !== uid) return null;
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(uid);
  if (!user || user.session_version !== p.v) return null;
  return user;
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
    if (u) out.push({ id: u.id, email: u.email });
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

    if (p === "/api/login" && req.method === "POST") {
      if (limited(ip)) { json(res, 429, { error: "Çok fazla deneme — 1 dakika bekle" }); return; }
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch {}
      const email = String(body.email || "").trim().toLowerCase();
      const user = db.prepare("SELECT * FROM users WHERE email=?").get(email);
      if (!user || !verifyHash(user.pass_hash, body.password || "")) {
        json(res, 401, { error: "E-posta ya da parola yanlış" });
        return;
      }
      const tok = sign({ u: user.id, v: user.session_version, exp: Date.now() + SESSION_MS });
      const cookies = [sessionCookie(user.id, tok), activeCookie(user.id)];

      let deviceId = getCookie(req, "did");
      if (!deviceId || !/^[a-f0-9]{32}$/.test(deviceId)) { deviceId = crypto.randomBytes(16).toString("hex"); cookies.push(deviceCookie(deviceId)); }
      const known = db.prepare("SELECT 1 FROM known_devices WHERE user_id=? AND device_id=?").get(user.id, deviceId);
      if (!known) {
        db.prepare("INSERT INTO known_devices(user_id,device_id,created,last_seen) VALUES(?,?,?,?)").run(user.id, deviceId, Date.now(), Date.now());
        sendMail(user.email, "defter. — yeni cihazdan giriş", newDeviceHtml(ip, req.headers["user-agent"])).catch(() => {});
      } else {
        db.prepare("UPDATE known_devices SET last_seen=? WHERE user_id=? AND device_id=?").run(Date.now(), user.id, deviceId);
      }

      json(res, 200, { ok: true, email: user.email }, { "Set-Cookie": cookies });
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
      json(res, 200, { ok: true, email: user.email }, { "Set-Cookie": [activeCookie(uid)] });
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
      const user = db.prepare("SELECT * FROM users WHERE email=?").get(email);
      if (user) {
        const token = crypto.randomBytes(32).toString("base64url");
        const hash = crypto.createHash("sha256").update(token).digest("hex");
        db.prepare("INSERT INTO password_resets(token_hash,user_id,expires,used) VALUES(?,?,?,0)").run(hash, user.id, Date.now() + RESET_MS);
        sendMail(user.email, "defter. — parola sıfırlama", forgotHtml(APP_URL + "/reset?token=" + token)).catch(() => {});
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
      const user = db.prepare("SELECT * FROM users WHERE id=?").get(row.user_id);
      if (!user) { json(res, 400, { error: "Bağlantı geçersiz veya süresi dolmuş" }); return; }
      db.prepare("UPDATE users SET pass_hash=?, session_version=session_version+1 WHERE id=?").run(makeHash(pass), user.id);
      db.prepare("UPDATE password_resets SET used=1 WHERE token_hash=?").run(hash);
      sendMail(user.email, "defter. — parolan değişti", passwordChangedHtml()).catch(() => {});
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

      if (p === "/api/me" && req.method === "GET") { json(res, 200, { id: user.id, email: user.email }); return; }

      if (p === "/api/password" && req.method === "POST") {
        let body = {};
        try { body = JSON.parse(await readBody(req)); } catch {}
        if (!verifyHash(user.pass_hash, body.current || "")) { json(res, 403, { error: "Mevcut parola yanlış" }); return; }
        if (String(body.next || "").length < 8) { json(res, 400, { error: "Yeni parola en az 8 karakter olmalı" }); return; }
        const newVersion = user.session_version + 1;
        db.prepare("UPDATE users SET pass_hash=?, session_version=? WHERE id=?").run(makeHash(body.next), newVersion, user.id);
        const tok = sign({ u: user.id, v: newVersion, exp: Date.now() + SESSION_MS });
        sendMail(user.email, "defter. — parolan değişti", passwordChangedHtml()).catch(() => {});
        json(res, 200, { ok: true }, { "Set-Cookie": [sessionCookie(user.id, tok)] });
        return;
      }

      if (p === "/api/data" && req.method === "GET") {
        json(res, 200, { seq: userSeq(user.id), data: buildState(user.id) });
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

      json(res, 404, { error: "Yok" });
      return;
    }

    if (p === "/") {
      const user = authedUser(req);
      if (!user) { res.writeHead(302, { Location: "/login" }); res.end(); return; }
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
