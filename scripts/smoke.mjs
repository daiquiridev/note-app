#!/usr/bin/env node
/* defter. smoke testi — geçici bir DB ile sunucuyu ayağa kaldırıp veri-kritik akışları
   gerçek HTTP üzerinden doğrular: login, sync, tombstone, eski-istemci koruması, proje taşıma.
   Kullanım: node scripts/smoke.mjs   (Node 22+; hiçbir kalıcı dosyaya dokunmaz) */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "server.js");
const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), "defter-smoke-"));
const ENV = { ...process.env, SECRET: "smoke-secret", DATA_DIR, PORT: String(PORT) };

let passed = 0, failed = 0;
const ok = (cond, name, detail = "") => {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.error("  ✗ " + name + (detail ? " — " + detail : "")); }
};

const cli = (...args) => execFileSync("node", [SERVER, ...args], { env: ENV, encoding: "utf8" });

/* ── kurulum: 2 proje + 1 login ── */
cli("user-add", "p1@smoke.local", "parola123");
cli("user-add", "p2@smoke.local", "parola123");
const db = new DatabaseSync(join(DATA_DIR, "defter.db"), { readOnly: true });
const [P1, P2] = ["p1@smoke.local", "p2@smoke.local"].map(e => db.prepare("SELECT id FROM users WHERE email=?").get(e).id);
db.close();
cli("login-adopt", "smoke@login.local", P1);
cli("project-link", P2, "smoke@login.local", "İkinci");

/* ── sunucuyu başlat ── */
const srv = spawn("node", [SERVER], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
srv.stderr.on("data", d => process.stderr.write("[server] " + d));
const die = code => { srv.kill(); rmSync(DATA_DIR, { recursive: true, force: true }); process.exit(code); };
for (let i = 0; ; i++) {
  try { if ((await fetch(BASE + "/healthz")).ok) break; } catch {}
  if (i > 50) { console.error("sunucu açılmadı"); die(1); }
  await new Promise(r => setTimeout(r, 100));
}

const jar = {};
const remember = res => { for (const c of res.headers.getSetCookie()) { const [kv] = c.split(";"); const [k, ...v] = kv.split("="); jar[k.trim()] = v.join("="); } };
const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
const api = async (path, opts = {}) => {
  const res = await fetch(BASE + path, { ...opts, headers: { "Content-Type": "application/json", Cookie: cookieHeader(), ...(opts.headers || {}) } });
  remember(res);
  return res;
};

try {
  console.log("1) kimlik doğrulama");
  ok((await fetch(BASE + "/api/data")).status === 401, "oturumsuz /api/data → 401");
  const login = await api("/api/login", { method: "POST", body: JSON.stringify({ email: "smoke@login.local", password: "parola123" }) });
  const lj = await login.json();
  ok(login.status === 200, "login 200", JSON.stringify(lj));
  ok(jar["sid_" + P1] && jar["sid_" + P2], "iki projenin de oturum cookie'si verildi");
  ok((lj.projects || []).length === 2, "login yanıtında 2 proje");
  const badLogin = await fetch(BASE + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "smoke@login.local", password: "yanlis" }) });
  ok(badLogin.status === 401, "yanlış parola → 401");

  console.log("2) senkron + kalıcılık");
  jar.active = P1;
  const note = id => ({ id, title: "not-" + id, updated: Date.now(), blocks: [{ id: id + "b", type: "p", html: "içerik" }] });
  const sync = async (baseSeq, notes) => {
    const r = await api("/api/sync", { method: "POST", body: JSON.stringify({ baseSeq, data: { notes, tasks: [], folders: [], mtime: Date.now() } }) });
    return { status: r.status, ...(await r.json()) };
  };
  const s1 = await sync(0, [note("n1")]);
  ok(s1.status === 200 && s1.seq > 0, "ilk push kabul edildi (seq=" + s1.seq + ")");
  const d1 = await (await api("/api/data")).json();
  ok(d1.data?.notes?.some(n => n.id === "n1"), "n1 sunucuda kalıcı");

  console.log("3) tombstone — bilinçli silme");
  const s2 = await sync(s1.seq, []);           // istemci n1'i biliyordu ve silmiş
  const d2 = await (await api("/api/data")).json();
  ok(!(d2.data?.notes || []).some(n => n.id === "n1"), "bilinen not silinince tombstone'landı");

  console.log("4) eski istemci koruması — veri kaybı sınıfı");
  const s3 = await sync(s2.seq, [note("n2")]); // n2 oluştur
  const stale = await sync(0, []);             // baseSeq=0'lık bayat istemci boş state gönderiyor
  ok(stale.changed === true, "bayat push'a 'changed' dönüldü");
  const d3 = await (await api("/api/data")).json();
  ok((d3.data?.notes || []).some(n => n.id === "n2"), "bayat istemci n2'yi SİLEMEDİ (koruma çalışıyor)");

  console.log("5) projeler arası taşıma");
  await sync(s3.seq, [note("n2"), note("n3")]);
  const mv = await api("/api/move", { method: "POST", body: JSON.stringify({ kind: "note", id: "n3", target: P2 }) });
  ok(mv.status === 200, "/api/move 200", String(mv.status));
  const d4 = await (await api("/api/data")).json();
  ok(!(d4.data?.notes || []).some(n => n.id === "n3"), "n3 kaynak projeden kalktı");
  jar.active = P2;
  const d5 = await (await api("/api/data")).json();
  ok((d5.data?.notes || []).some(n => n.id === "n3"), "n3 hedef projede");
  const mvBad = await api("/api/move", { method: "POST", body: JSON.stringify({ kind: "note", id: "n2", target: "olmayan-proje" }) });
  ok(mvBad.status === 403, "oturumu olmayan hedefe taşıma → 403", String(mvBad.status));

  console.log("6) korumalı uçlar");
  const sttNoAuth = await fetch(BASE + "/api/stt?lang=tr", { method: "POST", body: "x" });
  ok(sttNoAuth.status === 401, "oturumsuz /api/stt → 401", String(sttNoAuth.status));
  const sttAuthed = await api("/api/stt?lang=tr", { method: "POST", body: "x", headers: { "Content-Type": "application/octet-stream" } });
  ok(sttAuthed.status === 500, "oturumlu /api/stt, worker yapılandırılmamışken → 500 (401 değil)", String(sttAuthed.status));
  const sumNoAuth = await fetch(BASE + "/api/summarize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "x" }) });
  ok(sumNoAuth.status === 401, "oturumsuz /api/summarize → 401", String(sumNoAuth.status));
  const sumAuthed = await api("/api/summarize", { method: "POST", body: JSON.stringify({ text: "x" }) });
  ok(sumAuthed.status === 500, "oturumlu /api/summarize, worker yapılandırılmamışken → 500 (401 değil)", String(sumAuthed.status));
  const sumEmpty = await api("/api/summarize", { method: "POST", body: JSON.stringify({ text: "" }) });
  ok(sumEmpty.status === 400, "boş metin → 400", String(sumEmpty.status));

  console.log("7) tam metin arama (FTS5)");
  jar.active = P1;
  const distinctNote = { id: "n4", title: "Kadıköy toplantı notu", updated: Date.now(),
    blocks: [{ id: "n4b", type: "p", html: "zeplinkabagi projesiyle ilgili bütçe kararı" }] };
  const cur = await (await api("/api/data")).json();          // tam state'i al —
  const others = (cur.data?.notes || []).filter(n => n.id !== "n4"); // yalnızca yeni notu göndermek
  const s4 = await sync(cur.seq, [...others, distinctNote]);         // diğerlerini tombstone'lardı
  const search = async q => (await (await api("/api/search?q=" + encodeURIComponent(q))).json()).results;
  const r1 = await search("zeplinkabagi");
  ok(r1.some(x => x.id === "n4"), "içerikte geçen benzersiz kelime notu buluyor");
  const r1p = await search("zeplinka"); // prefix — tam kelime değil
  ok(r1p.some(x => x.id === "n4"), "prefix arama da (tam kelime değil) buluyor");
  await sync(s4.seq, others); // n4'ü sil, diğerleri kalsın
  const r2 = await search("zeplinkabagi");
  ok(!r2.some(x => x.id === "n4"), "silinen not arama sonuçlarında yok");
  jar.active = P2;
  const r3 = await search("zeplinkabagi");
  ok(r3.length === 0, "diğer projenin verisi arama sonuçlarına sızmıyor");
  jar.active = P1;
  for (const weird of ['"', "*", "(", "AND OR NOT"]) {
    const wr = await api("/api/search?q=" + encodeURIComponent(weird));
    ok(wr.status === 200, `arama '${weird}' ile 500 vermiyor`, String(wr.status));
  }

  console.log("8) şablonlar (settings blob üzerinden senkron)");
  const curForTpl = await (await api("/api/data")).json();
  const tplData = { notes: curForTpl.data?.notes || [], tasks: [], folders: [], mtime: Date.now(),
    templates: [{ id: "tpl1", name: "Test Şablonu", created: Date.now(), blocks: [{ id: "tb1", type: "p", html: "şablon içeriği" }] }] };
  const s5 = await api("/api/sync", { method: "POST", body: JSON.stringify({ baseSeq: curForTpl.seq, data: tplData }) });
  ok(s5.status === 200, "şablonlu push kabul edildi", String(s5.status));
  const d6 = await (await api("/api/data")).json();
  ok((d6.data?.templates || []).some(t => t.id === "tpl1"), "şablon sunucuda kalıcı (settings blob roundtrip)");

  console.log("9) hızlı yakalama (/yakala)");
  const yUnauth = await fetch(BASE + "/yakala?metin=deneme", { redirect: "manual" });
  ok(yUnauth.status === 302 && yUnauth.headers.get("location").startsWith("/login?return="), "oturumsuz /yakala → login'e yönleniyor (metni koruyarak)", yUnauth.headers.get("location"));
  ok(decodeURIComponent(yUnauth.headers.get("location")).includes("metin=deneme"), "return parametresi ?metin=... sorgu dizesini koruyor");

  const y1 = await fetch(BASE + "/yakala?metin=" + encodeURIComponent("ilk yakalama notu"), { headers: { Cookie: cookieHeader() }, redirect: "manual" });
  ok(y1.status === 302 && /^\/not\//.test(y1.headers.get("location") || ""), "oturumlu /yakala → nota yönleniyor", y1.headers.get("location"));
  const dailyId1 = y1.headers.get("location").split("/not/")[1];
  const y2 = await fetch(BASE + "/yakala?metin=" + encodeURIComponent("ikinci yakalama, aynı güne eklenmeli"), { headers: { Cookie: cookieHeader() }, redirect: "manual" });
  const dailyId2 = y2.headers.get("location").split("/not/")[1];
  ok(dailyId1 === dailyId2, "aynı gün içinde ikinci yakalama AYNI günlük nota ekleniyor (kopya oluşturmuyor)");
  const d7 = await (await api("/api/data")).json();
  const dailyNote = (d7.data?.notes || []).find(n => n.id === dailyId1);
  ok(dailyNote && dailyNote.blocks.some(b => b.html.includes("ilk yakalama notu")) && dailyNote.blocks.some(b => b.html.includes("ikinci yakalama")), "her iki metin de günlük notta");

  const yNew = await fetch(BASE + "/yakala?metin=" + encodeURIComponent("ayrı bir not olsun") + "&hedef=yeni", { headers: { Cookie: cookieHeader() }, redirect: "manual" });
  const newNoteId = yNew.headers.get("location")?.split("/not/")[1];
  ok(newNoteId && newNoteId !== dailyId1, "hedef=yeni farklı, yeni bir not oluşturuyor");

  const yEmpty = await fetch(BASE + "/yakala?metin=", { headers: { Cookie: cookieHeader() } });
  ok(yEmpty.status === 400, "boş metin → 400", String(yEmpty.status));

  console.log("10) PWA statik dosyalar + web push");
  const manifestR = await fetch(BASE + "/manifest.webmanifest");
  ok(manifestR.status === 200 && (await manifestR.json()).name === "defter.", "manifest.webmanifest sunuluyor");
  const swR = await fetch(BASE + "/sw.js");
  ok(swR.status === 200 && (await swR.text()).includes("self.addEventListener"), "sw.js sunuluyor");
  const iconR = await fetch(BASE + "/icons/icon-192.png");
  ok(iconR.status === 200 && iconR.headers.get("content-type") === "image/png", "icon PNG sunuluyor");

  const vapidR = await api("/api/push/vapid-key");
  ok(vapidR.status === 200, "vapid-key uotomatik 200", String(vapidR.status));
  const subBad = await api("/api/push/subscribe", { method: "POST", body: JSON.stringify({ endpoint: "https://example.com/x" }) });
  ok(subBad.status === 400, "eksik keys ile subscribe → 400", String(subBad.status));
  const subOk = await api("/api/push/subscribe", { method: "POST", body: JSON.stringify({ endpoint: "https://example.com/push/abc", keys: { p256dh: "p", auth: "a" } }) });
  ok(subOk.status === 200, "geçerli subscribe → 200", String(subOk.status));
  const unsub = await api("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: "https://example.com/push/abc" }) });
  ok(unsub.status === 200, "unsubscribe → 200", String(unsub.status));

  const pastDue = new Date(Date.now() - 3600_000).toISOString().slice(0, 16);
  await sync((await (await api("/api/data")).json()).seq, others); // temiz taban
  const curTasks = await (await api("/api/data")).json();
  const rTask = { baseSeq: curTasks.seq, data: { notes: others, tasks: [{ id: "rt1", text: "Vadesi geçmiş görev", done: false, due: pastDue, remind: true, notified: false, created: Date.now(), updated: Date.now() }], folders: [], mtime: Date.now() } };
  await api("/api/sync", { method: "POST", body: JSON.stringify(rTask) });
  const rem1 = await (await api("/api/reminders/pending")).json();
  ok((rem1.reminders || []).some(r => r.id === "rt1"), "vadesi geçmiş+remind görevi pending listede");
  const rem2 = await (await api("/api/reminders/pending")).json();
  ok(!(rem2.reminders || []).some(r => r.id === "rt1"), "ikinci çağrıda AYNI görev tekrar dönmüyor (notified=true)");
} catch (e) {
  console.error("beklenmeyen hata:", e);
  failed++;
}

console.log(`\nSONUÇ: ${passed} geçti, ${failed} kaldı`);
die(failed ? 1 : 0);
