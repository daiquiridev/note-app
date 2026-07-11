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

## CLI komutları

```bash
node server.js user-add <email> <parola>        # yeni proje (legacy kullanıcı) oluştur
node server.js user-pass <email> <parola>       # parola değiştir (tüm oturumları düşürür)
node server.js login-add <email> <parola>       # yeni login oluştur
node server.js login-adopt <email> <proje_id>   # mevcut projenin parolasıyla login oluştur
node server.js project-link <proje_id> <login_email> [ad]  # projeyi login'e bağla
node server.js mcp-key-add <login_email> [etiket]   # MCP statik API key üret
node server.js mcp-key-list [email] / mcp-key-revoke <önek>
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

## STT Worker

`workers/stt/` — Cloudflare Workers AI (`whisper-large-v3-turbo`) proxy'si.

```bash
cd workers/stt
wrangler deploy
echo "<secret>" | wrangler secret put STT_SECRET   # sunucudaki STT_WORKER_SECRET ile aynı olmalı
```
