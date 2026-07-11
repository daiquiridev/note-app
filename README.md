# defter.

Notion-tarzı, **sıfır npm bağımlılıklı** not & görev uygulaması. Tek Node.js dosyası (`server.js`,
`node:sqlite` ile) + tek HTML dosyalık istemci (`public/index.html`). Prod: https://notes.daiquiri.dev

## Özellikler

- Blok editörü: başlık/liste/yapılacak/alıntı/kod/toggle/görsel, `/` komut menüsü, Markdown kısayolları,
  blok sürükle-bırak, Tab ile girinti
- Görevler (tarih + hatırlatıcı + süre takibi), takvim, komut paleti (Ctrl+K), PIN kilidi
- Tek login altında çoklu proje (İş / Kişisel), projeler arası not/klasör taşıma
- Sesli yazdırma (Web Speech API) + toplantı kaydı: mikrofon ve sistem sesi ayrı ayrı yazıya dökülür
  (Cloudflare Worker → Workers AI Whisper)
- Çevrimdışı çalışır (localStorage); sunucuyla öğe-bazlı merge senkronizasyonu
- MCP sunucusu (`/mcp`): Claude'dan not/görev okuma-yazma; statik API key veya OAuth 2.1 + PKCE
- Tam metin arama (SQLite FTS5): notlar, görev açıklamaları ve klasörler Ctrl+K'dan aranabilir
- AI özeti: tek tıkla not özeti + aksiyon listesi (Workers AI LLM, aynı STT Worker üzerinden)
- Günlük not + şablonlar; hızlı yakalama (`/yakala`) ile telefondan/tarayıcıdan tek adımda not düşme
- `[[not bağlantısı]]` + backlinks paneli ("Bundan bahsedenler")
- PWA (ana ekrana eklenebilir) + Web Push görev hatırlatıcıları (uygulama kapalıyken de çalışır)

## Çalıştırma

Node 22+ gerekir (`node:sqlite`).

```bash
SECRET=<rastgele-hex> DATA_DIR=./data PORT=8080 node server.js
```

### Ortam değişkenleri

| Değişken | Zorunlu | Açıklama |
|---|---|---|
| `SECRET` | ✅ | Oturum imzalama anahtarı |
| `DATA_DIR` | — | SQLite dizini (varsayılan `/data`) |
| `PORT` | — | Varsayılan 80 |
| `RESEND_API_KEY`, `MAIL_FROM` | — | E-posta (yeni cihaz bildirimi, parola sıfırlama) |
| `APP_URL` | — | Mutlak URL üretimi (e-postadaki linkler, OAuth) |
| `STT_WORKER_URL`, `STT_WORKER_SECRET` | — | Toplantı transkripsiyonu için Worker adresi + Bearer secret |
| `VAPID_PUBLIC`, `VAPID_PRIVATE`, `VAPID_SUBJECT` | — | Web Push imzalama anahtarları (`node server.js vapid-gen` ile üret) |

## CLI komutları

```bash
node server.js user-add <email> <parola>        # yeni proje (legacy kullanıcı) oluştur
node server.js user-pass <email> <parola>       # parola değiştir (tüm oturumları düşürür)
node server.js login-add <email> <parola>       # yeni login oluştur
node server.js login-adopt <email> <proje_id>   # mevcut projenin parolasıyla login oluştur
node server.js project-link <proje_id> <login_email> [ad]  # projeyi login'e bağla
node server.js mcp-key-add <login_email> [etiket]   # MCP statik API key üret
node server.js mcp-key-list [email] / mcp-key-revoke <önek>
node server.js vapid-gen                        # Web Push imzalama anahtar çifti üret (bir kez)
```

## Deploy (Hetzner)

Kaynak dizin sunucuda `/opt/defter/`. Statik dosyalar başlangıçta belleğe okunur —
**her değişiklik container rebuild gerektirir:**

```bash
scp server.js public/index.html root@<sunucu>:/opt/defter/...
ssh root@<sunucu> "cd /opt/defter && docker compose up -d --build"
```

Şema değişikliğinden önce `/data/defter.db*` (db + wal + shm) yedeği alın.

## Hızlı yakalama (`/yakala`)

`GET|POST /yakala?metin=...&hedef=gunluk|yeni` — oturum korumalı. `hedef=gunluk` (varsayılan)
bugünün "Günlük — <tarih>" notuna metni ekler (yoksa oluşturur); `hedef=yeni` ayrı bir not açar.
Oturum yoksa `/login?return=...` ile giriş sonrası otomatik tamamlanır. Yanıt: notun sayfasına 302.

**iOS Kısayolu:** Kısayollar uygulamasında yeni kısayol → "Metin İste" → "URL"
(`https://notes.daiquiri.dev/yakala?metin=[Sağlanan Girdi]`, metni URL-kodlaması otomatik) →
"URL'yi Aç". Ana ekrana ekleyip paylaşım sayfasına da eklenebilir (Kısayollar → ⋯ → "Paylaşım
Sayfasında Göster").

**Bookmarklet (masaüstü tarayıcı):** Yer imi çubuğuna sürüklenecek bir link olarak kaydet:
```
javascript:location.href='https://notes.daiquiri.dev/yakala?metin='+encodeURIComponent(window.getSelection().toString()||document.title+' '+location.href)
```
Seçili metin varsa onu, yoksa sayfa başlığı + URL'ini günlük nota ekler.

## PWA + Web Push

`public/manifest.webmanifest` + `public/sw.js` + `public/icons/`. Kurulum:
1. `node server.js vapid-gen` → çıktıyı `.env`'e ekle, sunucuyu yeniden başlat.
2. Ayarlar → Bildirimler → "Bildirimleri aç" (tarayıcı izin ister).
3. iOS'ta Web Push yalnızca **ana ekrana eklenmiş** PWA'da çalışır (iOS 16.4+); Safari
   sekmesinden değil, "Ana Ekrana Ekle" sonrası açılan uygulamadan izin ver.

Push **payload'sız**: sunucu yalnızca "uyandırma" sinyali gönderir (VAPID imzalı, boş gövde —
RFC 8291 şifrelemesi gerekmez), service worker `push` olayında `/api/reminders/pending`'i çekip
bildirimi kendisi gösterir. Sunucu tarafında her 60 saniyede bir vadesi gelen görevler taranır
(`scanReminders`) — bu, uygulama/sekme kapalıyken de bildirim gelmesini sağlar; uygulama açıkken
zaten çalışan istemci-içi hatırlatıcıyla birlikte çalışır, çakışma riski yok (`notified` alanı
her iki tarafta da paylaşılır).

## STT Worker

`workers/stt/` — Cloudflare Workers AI (`whisper-large-v3-turbo`) proxy'si.

```bash
cd workers/stt
wrangler deploy
echo "<secret>" | wrangler secret put STT_SECRET   # sunucudaki STT_WORKER_SECRET ile aynı olmalı
```
