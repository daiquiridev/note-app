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
