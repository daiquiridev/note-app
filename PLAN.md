# defter. — Yol Haritası ve Uygulama Planı

> Bu doküman, uygulamayı yapacak agent (Sonnet) için **bağımsız ve eksiksiz** yazılmıştır.
> Konuşma geçmişine erişimin olmadığını varsayar. Sırayla ilerle; her fazın sonunda
> "Kabul kriterleri"ni doğrulamadan ve deploy etmeden bir sonrakine geçme.

---

## 0. Proje bağlamı (önce oku)

- **Ne:** Notion-tarzı kişisel not+görev uygulaması. Prod: https://notes.daiquiri.dev
- **Mimari:** `server.js` (tek dosya, Node 24, **sıfır npm bağımlılığı**, `node:sqlite`) +
  `public/index.html` (tek dosya vanilla JS istemci) + `workers/stt/` (Cloudflare Worker, Whisper STT).
- **Felsefe (bozma):** Sunucuya ve istemciye **hiçbir npm paketi eklenmez**. Her şey `node:` çekirdek
  modülleri ve tarayıcı API'leriyle yazılır. Tek kişilik proje; okunabilirlik > soyutlama.
- **Deploy:** Hetzner `root@91.99.190.45` (SSH anahtarı `~/.ssh/hetzner_key`), kaynak `/opt/defter/`,
  container `defter_app`. Statik dosyalar açılışta belleğe okunur → **her değişiklik rebuild ister**:
  ```bash
  scp -i ~/.ssh/hetzner_key server.js public/index.html root@91.99.190.45:/opt/defter/...
  ssh -i ~/.ssh/hetzner_key root@91.99.190.45 "cd /opt/defter && docker compose up -d --build"
  ```
- **Veri:** SQLite, WAL modu, volume `defter_defter_data` → `/data`. Container `node` (uid 1000)
  kullanıcısıyla çalışır — `/data`'ya eklenen dosyaların sahibi node olmalı.
- **Şema değişikliği öncesi zorunlu:** `/data/defter.db*` yedeği al (Faz 1'deki yedek scripti de kullanılabilir).
- **Test:** `node scripts/smoke.mjs` (16 kontrol, ~5 sn). **Her fazda yeni uçlar için kontrol ekle**
  ve tamamı yeşil kalmadan deploy etme. Sözdizimi: `node --check server.js` + index.html içi script'leri
  çıkarıp `node --check` (scripts/smoke.mjs'in başındaki pattern'e bak).
- **Senkron modeli (bozması kolay, dikkat):** İstemci tüm state'i `POST /api/sync {baseSeq, data}` ile
  yollar; sunucu öğe bazında birleştirir. Silme = tombstone (`deleted=1`), **yalnızca** istemcinin
  bildiği (`seq <= baseSeq`) öğeler için. Bu değişmezleri bozan her değişiklik veri kaybı üretir —
  smoke testteki "bayat istemci koruması" senaryosu bu yüzden var.
- **Kimlik modeli:** `logins` (e-posta+parola) → N × `users` (proje; ör. `work`, `personal`).
  Cookie'ler: `sid_<projeId>` + `active`. MCP/OAuth uçları mevcut ve çalışıyor; dokunma.

---

## Fazlar — genel bakış ve sıra

| Faz | İş | Efor | Bağımlılık |
|---|---|---|---|
| 1 | Gece yedeği → Cloudflare R2 | S | — |
| 2 | AI özet + aksiyon çıkarma | M | — |
| 3 | FTS5 tam metin arama | M | — |
| 4 | Günlük not + şablonlar | S | — |
| 5 | Hızlı yakalama (`/yakala`) | S | 4 (günlük nota ekleme için) |
| 6 | `[[backlink]]`ler | M | 3 (isteğe bağlı; arama altyapısını kullanır) |
| 7 | PWA + Web Push hatırlatıcılar | L | — |
| 8 | macOS + iOS uygulamaları | L | 5, 7 |

S ≈ yarım gün altı · M ≈ 1 gün · L ≈ 2-3 gün. Fazlar 1-4 birbirinden bağımsızdır; sıra önerilir ama şart değil.

---

## Faz 1 — Gece yedeği → Cloudflare R2

**Neden:** Tek kopya veri prod SQLite'ta. Kullanıcı iki kez veri kaybı korkusu yaşadı; otomatik
dış yedek en yüksek güven/efor oranı.

**Nasıl:**
1. R2 kimlik bilgileri Bitwarden'da **"Cloudflare R2 - dagkanbayramoglu-com"** kaydında
   (kullanıcı `bwu` ile vault açar; anahtarları kullanıcıdan iste, koda/repoya yazma).
2. `defter-backups` adında R2 bucket'ı oluştur (Cloudflare hesabı mevcut; wrangler yetkili:
   `wrangler r2 bucket create defter-backups`).
3. Hetzner host'una `rclone` kur (host aracı; uygulamanın sıfır-bağımlılık kuralına dahil değil)
   ve R2 remote'u yapılandır (S3 uyumlu API).
4. `/opt/defter/backup.sh`:
   - `docker exec defter_app node -e "new (require('node:sqlite').DatabaseSync)('/data/defter.db').exec(\"VACUUM INTO '/data/backup-tmp.db'\")"`
     (WAL güvenli, tutarlı anlık kopya)
   - `docker cp` ile çıkar → `rclone copyto` ile `defter-backups/defter-YYYY-MM-DD.db`'ye yükle
   - tmp dosyayı sil; R2'de 14 günden eskiyi sil (`rclone delete --min-age 14d`)
5. Cron: her gün 04:15 → `crontab -e` (root).
6. **Geri dönüş prosedürünü README'ye ekle** (indirilen .db dosyasını volume'a koyup rebuild).

**Kabul kriterleri:**
- [ ] Script elle çalıştırılınca R2'de o günün dosyası görünüyor (`rclone ls`)
- [ ] İndirilen yedek `sqlite3`/node ile açılıp `SELECT count(*) FROM items` çalışıyor
- [ ] Cron kaydı var; ertesi gün dosyanın düştüğü doğrulanmış
- [ ] README'de geri dönüş prosedürü

---

## Faz 2 — AI özet + aksiyon çıkarma (tek tık)

**Neden:** Kullanıcının açık isteği. Toplantı notu (STT çıktısı) uzun ve dağınık; tek tıkla
özet + aksiyon listesi.

**Mimari:** Mevcut STT Worker'ına ikinci uç ekle (aynı hesap, ek anahtar yok):
- `workers/stt/src/index.js` → path'e göre ayır: `POST /` = mevcut STT, `POST /summarize` = yeni.
- `/summarize`: body `{text, mode}` alır; Workers AI LLM'i çağırır
  (`@cf/meta/llama-3.3-70b-instruct-fp8-fast` ile başla; model adını `env`'den yapılandırılabilir yap).
  Türkçe prompt: özet (3-5 madde) + `AKSIYONLAR:` başlığı altında `- [ ]` satırları döndürsün.
  Aynı `STT_SECRET` Bearer doğrulaması (mevcut `safeEqual` fonksiyonunu kullan).
- `server.js`: `POST /api/summarize` (oturum korumalı, `/api/` bloğunun içine) → Worker'a proxy.
  `STT_WORKER_URL + "/summarize"`. Not metnini `noteToText()` benzeri düz metne çevirip gönder
  (fonksiyon MCP bölümünde zaten var, yeniden kullan).
- `public/index.html`: not sayfası üst çubuğuna "✨ Özet" ikonu (yalnızca not modunda görünür,
  `btnMic` deseniyle). Tıklanınca:
  1. Yanıt gelene dek buton spinner durumuna geçer (tekrar tıklamayı kilitle).
  2. Dönen özet, notun **en üstüne** `toggle` bloğu ("AI Özeti — <tarih>") + altına girintili
     `p` blokları olarak eklenir (toggle/indent altyapısı mevcut).
  3. `AKSIYONLAR` satırları bir onay listesi modal'ında gösterilir; kullanıcı seçtiklerini
     onaylayınca `state.tasks`'a eklenir (`addTask` deseni). **Sormadan görev ekleme.**

**Dikkat:** Yanıt eklenirken `rerenderBlocks` yerine mevcut `appendLabeledTranscript` benzeri
nokta-ekleme yaklaşımı kullan; kullanıcı o an yazıyorsa imleci koparma (bkz. `isActivelyEditingNote`).

**Kabul kriterleri:**
- [ ] Uzun bir toplantı notunda tek tık → 5 sn içinde özet toggle'ı en üstte
- [ ] Aksiyon onay listesinden seçilenler Görevler'e düşüyor, seçilmeyenler düşmüyor
- [ ] Oturumsuz `POST /api/summarize` → 401 (smoke'a ekle)
- [ ] Worker'a yanlış secret → 401 (curl ile)
- [ ] Boş/çok kısa not → kullanıcıya anlamlı toast, istek atılmaz

---

## Faz 3 — FTS5 tam metin arama

**Doğrulandı:** FTS5 hem lokalde (Node 22) hem prod container'ında (Node 24) mevcut —
`CREATE VIRTUAL TABLE ... USING fts5(...)` çalışıyor. Fallback gerekmiyor.

**Nasıl:**
- Şema (migrate bölümüne, `CREATE TABLE IF NOT EXISTS` bloklarının yanına):
  ```sql
  CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
    user_id UNINDEXED, kind UNINDEXED, id UNINDEXED, title, body,
    tokenize='unicode61 remove_diacritics 2'
  );
  ```
- İndeksleme: `syncUser`'daki upsert ve `upsertItem`/`deleteItem` (MCP) noktalarında
  fts satırını sil+ekle (`DELETE FROM items_fts WHERE id=? AND user_id=?` → `INSERT`).
  `title` = not başlığı / görev metni; `body` = blokların düz metni (`noteToText` yeniden kullan).
  Tombstone'da fts satırını sil.
- İlk kurulum migration'ı: `items_fts` boşsa mevcut tüm `deleted=0` öğeleri indeksle
  (migrate() içinde, idempotent).
- `GET /api/search?q=...` (oturum korumalı): aktif kullanıcının öğelerinde
  `snippet(items_fts, 4, '<b>', '</b>', '…', 12)` ile ilk 20 sonuç.
- UI: Ctrl+K paletine entegre — mevcut başlık eşleşmeleri anında (yerel) gösterilmeye devam eder;
  300 ms debounce ile `/api/search` sonuçları "İçerikte geçenler" bölümü olarak altına eklenir.
  Sonuca Enter → notu aç. Kenar çubuğu araması (`sideSearch`) dokunma; o başlık filtresi olarak kalsın.

**Dikkat:** FTS sorgu sözdizimi hatası (kullanıcı `"` yazarsa) 500 atmasın — try/catch ile
`q`'yu `'"' + q.replaceAll('"','""') + '"'` şeklinde tırnakla.

**Kabul kriterleri:**
- [ ] İçeriği bilinen bir kelimeyle Ctrl+K → ilgili not "İçerikte geçenler"de, snippet'li
- [ ] Silinen notun içeriği artık sonuçlarda çıkmıyor
- [ ] Diğer projenin (user_id) verisi sonuçlara sızmıyor (smoke'a kontrol ekle)
- [ ] `"`, `*`, `(` gibi girişlerde 500 yok

---

## Faz 4 — Günlük not + şablonlar

**Nasıl:**
- **Günlük not:** Ctrl+K'ya "Bugünün notu" komutu (`kw: "gunluk bugun daily journal"`).
  Başlığı `Günlük — 11 Temmuz 2026` formatında (tr-TR) bir not ara; varsa aç, yoksa şablonla
  oluştur (h3 "Notlar", p; h3 "Yapılacaklar", todo). Klasörsüz ("Diğer") dursun.
  Kısayol: `Ctrl+Alt+G`. Karşılama sayfasına da "Bugünün notu" düğmesi ekle (`btn-meet` deseni).
- **Şablonlar:** `state.templates = [{id, name, blocks}]` (settings öğesiyle birlikte senkronlanır —
  `collectClientItems`'taki settings json'ına `templates` alanını ekle; sunucu şeması değişmez,
  json içinde taşınır). UI:
  - Bir notu şablona çevir: not menüsüne / Ctrl+K'ya "Şablon olarak kaydet" (blokları kopyalar,
    id'leri yeniden üretir).
  - Yeni not oluştururken: Ctrl+K "Şablondan yeni not" → picker (`openPicker` mevcut).
  - Şablon silme: aynı picker'da satır sonunda çöp ikonu gerekmez; "Şablonları yönet" basit
    bir picker + sil onayı yeterli.

**Kabul kriterleri:**
- [ ] "Bugünün notu" iki kez çağrılınca ikinci sefer aynı notu açıyor (duplikasyon yok)
- [ ] Şablondan oluşturulan notta blok id'leri özgün (iki not aynı id'yi paylaşmıyor)
- [ ] Şablonlar başka cihazda da görünüyor (senkron üzerinden)

---

## Faz 5 — Hızlı yakalama

**Nasıl:**
- `GET /yakala?metin=...&hedef=gunluk|yeni` (oturum korumalı; oturumsuzsa
  `/login?return=<tam-url>` — mevcut `safeReturn` mekanizması bunu zaten taşır):
  - `hedef=gunluk` (varsayılan): bugünün günlük notu yoksa oluştur, metni sona `p` bloğu olarak
    ekle (`upsertItem` deseni; **senkron çekirdeğini kullanma**, MCP'deki tekil CRUD yolunu kullan).
  - `hedef=yeni`: başlığı metnin ilk ~60 karakteri olan yeni not.
  - Yanıt: notun sayfasına `302` (URL sistemi mevcut: `/not/<id>`).
- POST varyantı da ekle (`/yakala` JSON body) — iOS Kısayolu URL'den, ileride Share Extension
  POST'tan kullanır.
- **iOS Kısayolu tarifi README'ye:** "Metin İste" → "URL" (`https://notes.daiquiri.dev/yakala?metin=[metin]`)
  → "URL'yi Aç". (Safari'de oturum açıksa cookie taşınır.)
- **Bookmarklet** README'ye: seçili metni + sayfa URL'ini yakalar.

**Dikkat:** GET ile yazma işlemi CSRF hedefi olabilir — `SameSite=Lax` cookie'ler top-level GET'te
gider. Risk: kötü site `<a href=".../yakala?metin=spam">` tıklatabilir. Kabul edilebilir (yalnızca
not ekler, silmez) ama yine de metni 2 KB ile sınırla ve `hedef` dışında parametre işleme.

**Kabul kriterleri:**
- [ ] Oturumlu tarayıcıda `/yakala?metin=deneme` → günlük nota eklenip nota yönlendiriyor
- [ ] Oturumsuz → login → sonra otomatik yakalama tamamlanıyor
- [ ] iPhone Kısayolu ile uçtan uca çalışıyor (kullanıcıyla birlikte test)
- [ ] Smoke: oturumsuz 302 login, oturumlu 302 `/not/...`

---

## Faz 6 — `[[backlink]]`ler

**Nasıl (istemci ağırlıklı, sunucu değişikliği yok):**
- **Yazarken:** blok içinde `[[` yazılınca not başlıkları picker'ı açılır (`openSlash` deseni —
  yeni bir mini popup; mevcut slash menüsünü bozma). Seçim `<a data-note-link="<id>">Başlık</a>`
  olarak eklenir. `esc`/filtreleme slash menüsündekiyle aynı.
- **Render:** `blockEl` içinde `data-note-link` tıklaması → `openNote(id)`. Not silinmişse toast.
- **Backlinks paneli:** `openNote` sonunda, tüm `state.notes` içinde bu nota `data-note-link`
  veren notları tara (istemci-yerel; N küçük). Varsa sayfa altına "↩ Bundan bahsedenler" bölümü.
- **Başlık değişirse:** link metni bayatlayabilir — kabul edilebilir (Notion da aynı). İsteğe
  bağlı iyileştirme: render sırasında `noteById(id).title` ile metni tazele.

**Dikkat:** `plainPaste` ve paste handler'ları `<a>` etiketini süpürmesin diye link ekleme
programatik yapılır (execCommand insertHTML yerine Range API ile node ekle). XSS: href kullanma,
yalnızca `data-note-link` + JS ile aç.

**Kabul kriterleri:**
- [ ] `[[` → picker → seçim → tıklanabilir link; tıklayınca not açılıyor ve URL güncelleniyor
- [ ] Hedef notta "Bundan bahsedenler" bölümü kaynağı listeliyor
- [ ] Link verilen not silinince tıklama zarifçe toast veriyor (hata yok)
- [ ] Senkron sonrası (başka cihazda) linkler çalışıyor

---

## Faz 7 — PWA + Web Push hatırlatıcılar

**Neden:** Görev hatırlatıcıları şu an yalnızca sekme açıkken çalışıyor (istemcide setInterval).
PWA + push ile uygulama kapalıyken de bildirim gelir; iOS/macOS'ta "uygulama" hissi verir.

**Nasıl:**
1. **Manifest + ikonlar:** `public/manifest.webmanifest` (name "defter.", `display: standalone`,
   theme/arka plan renkleri index.html'deki `--accent`/arka plan token'larından). İkon: mevcut
   kalem logosu SVG'sinden 192/512/maskable PNG üret + iOS için `apple-touch-icon` (180px).
   `server.js`'e statik servis ekle (LOGIN/RESET gibi belleğe oku; `Content-Type` doğru olsun).
2. **Service worker (`public/sw.js`):** app-shell cache (yalnızca `/login` ve statik ikonlar;
   **`/` ve `/not/*` cache'leme** — kimlikli HTML'dir, network-first + offline'da localStorage'lı
   istemci zaten çalışıyor). Basit sürümleme: SW dosyasında `const V = "1"` ve deploy'da artır.
3. **Web Push (sıfır bağımlılık):**
   - VAPID anahtar çifti üret (`crypto.generateKeyPairSync("ec", {namedCurve:"prime256v1"})`),
     private key `.env`'e (`VAPID_PRIVATE`, `VAPID_PUBLIC`, `VAPID_SUBJECT=mailto:...`).
   - **Payload'sız push kullan** (kritik sadeleştirme): RFC 8291 payload şifrelemesi gerekmez.
     Push yalnızca "uyandırma"dır; SW `push` olayında `GET /api/reminders/pending` çağırıp
     `showNotification` yapar. Böylece tek kripto işi VAPID JWT'si (ES256) — `node:crypto`
     `createSign("SHA256")` + JOSE-DER imza dönüşümü (~40 satır; DER→raw r||s dönüştürmeyi unutma).
   - Şema: `push_subs(login_id, endpoint PRIMARY KEY, p256dh, auth, created)`.
     Uçlar: `POST /api/push/subscribe`, `POST /api/push/unsubscribe` (oturum korumalı).
   - **Sunucu tarafı hatırlatıcı motoru:** `setInterval` 60 sn — `items`'ta kind='task',
     deleted=0 olan json'ları tarayıp `due<=now AND remind AND NOT notified` görevler için
     push gönder; görevin `notified` alanını güncelle (upsertItem ile, seq ilerlet ki istemciler
     senkronda alsın). 410/404 dönen abonelikleri sil.
   - İstemci: Ayarlar modal'ına "Bildirimler: Aç/Kapat" — `pushManager.subscribe`
     (`userVisibleOnly:true, applicationServerKey: VAPID_PUBLIC`).
4. **iOS notu:** Web Push yalnızca **ana ekrana eklenmiş** PWA'da çalışır (iOS 16.4+). README'ye
   kurulum adımı yaz.

**Dikkat:** Mevcut istemci-içi hatırlatıcı motoru kalsın (uygulama açıkken anlık); sunucu motoru
`notified`'ı set ettiğinde istemci senkronla görür, çift bildirim olasılığı düşük ve zararsız.

**Kabul kriterleri:**
- [ ] Chrome/macOS'ta yükle → uygulama penceresi, ikon, tema rengi doğru
- [ ] Tüm sekmeler kapalıyken vadesi gelen görev bildirimi geliyor (masaüstünde doğrula)
- [ ] iPhone'da ana ekrana ekle → bildirim izni → kapalıyken bildirim (kullanıcıyla test)
- [ ] Lighthouse PWA denetimi "installable" ✓
- [ ] Push aboneliği başka login'in görevini almıyor (smoke'a uç kontrolü)

---

## Faz 8 — macOS + iOS uygulamaları

### Framework kararı: **PWA (Faz 7) + yalın SwiftUI/WKWebView kabuk** — üçüncü parti framework YOK

Değerlendirilen seçenekler ve gerekçe:

| Seçenek | Artı | Eksi | Karar |
|---|---|---|---|
| Yalnız PWA | Sıfır ek kod, tasarım birebir | iOS'ta Share Extension, global kısayol, menü çubuğu yok | Temel katman ✓ |
| **SwiftUI + WKWebView kabuk** | **Sıfır üçüncü-parti bağımlılık** (yalnız Apple SDK), tek Xcode projesi 2 hedef, tasarım = web'in kendisi, Share Extension + menü çubuğu + global kısayol mümkün | Native his sınırlı (kabul: UI zaten web) | **✓ SEÇİLDİ** |
| Tauri 2 | Küçük binary, tek codebase | Rust toolchain + yeni ekosistem; projeye yabancı bağımlılık | ✗ |
| Capacitor | Olgun iOS köprüsü | npm ekosistemi — projenin sıfır-bağımlılık felsefesine aykırı | ✗ |
| Native SwiftUI (tam yeniden yazım) | En iyi platform hissi | Blok editörünün Swift'te ikinci kez yazımı + iki tasarım sisteminin senkron tutulması — tek kişilik projede sürdürülemez | ✗ |

"Aynı tasarım dili" gereksinimi kabuk yaklaşımıyla **tanım gereği** sağlanır: uygulama, prod
web arayüzünün kendisini gösterir; tasarım token'larının tek kaynağı `public/index.html`'deki
CSS değişkenleri kalır (`--accent`, `--glass*`, radius, font stack). Native eklenen her yüzey
(menü çubuğu popover'ı, paylaşım onayı) bu paletten renk alır.

### Yapı

```
apps/apple/Defter.xcodeproj
├── Shared/            WebView.swift (WKWebView sarmalayıcı), Config.swift (BASE_URL)
├── macOS/             DefterApp.swift, MenuBarExtra (hızlı yakalama), ayarlar
├── iOS/               DefterApp.swift (tam ekran WebView, safe-area)
└── iOS ShareExt/      Paylaşım uzantısı → POST /yakala
```

**Ortak (Shared):**
- `WKWebView`: `https://notes.daiquiri.dev` yükler; `websiteDataStore = .default()` (kalıcı çerez —
  oturum korunur); dış linkler sistem tarayıcısına; `allowsBackForwardNavigationGestures = true` (iOS).
- Ağ yoksa zarif offline sayfası (istemci localStorage'la zaten offline çalışır; yalnızca ilk
  yükleme başarısızlığını yakala, "yeniden dene" göster).

**macOS hedefi:**
- Tek pencere (min 900×600), başlık gizli (`.hiddenTitleBar`) — web UI kendi başlığını çiziyor.
- `MenuBarExtra`: kalem ikonu → küçük popover'da tek satır metin kutusu → Enter'da
  `POST https://notes.daiquiri.dev/yakala` (URLSession, çerezler WKWebView ile paylaşımlı olması
  için `HTTPCookieStorage` senkronu; en basiti popover yerine `/yakala?metin=` URL'ini gizli
  WKWebView'da açmak — çerez sorunu hiç doğmaz).
- Global kısayol `⌥⌘N` → menü çubuğu popover'ını açar (Carbon hotkey yerine
  `MenuBarExtra` + `keyboardShortcut`; global çalışması için "Launch at login" önerilir).
- `⌘1/⌘2` proje değiştirme, `⌘K` palet — kısayollar WebView'a JS ile iletilir
  (`evaluateJavaScript("openPalette()")` vb.).

**iOS hedefi:**
- Tam ekran WebView; `viewport-fit=cover` zaten index.html'de olmalı (yoksa ekle) +
  safe-area padding'i CSS `env(safe-area-inset-*)` ile (index.html'e küçük ekleme gerekir).
- **Share Extension:** paylaşılan metin/URL'i alır → `POST /yakala` (App Group'ta saklanan
  çerezle; oturum yoksa "önce uygulamada giriş yap" uyarısı) → başarı toast'u.
- Push: **Faz 7'deki Web Push, ana ekran PWA'sında zaten çalışıyor.** WKWebView içinde Web Push
  iOS 18.4+ gerektirir ve sınırlıdır — kabukta pushu v1 kapsam dışı bırak; bildirim isteyen
  kullanıcıya PWA kurulumu öner (README). (İleride gerekirse APNs + sunucuda ayrı uç: v2.)

**Dağıtım:** Kişisel kullanım — Apple Developer hesabıyla (99$/yıl) TestFlight; hesap yoksa
ücretsiz provisioning (7 günde bir yeniden imza gerekir — kullanıcıya sor). App Store hedefi yok.

**Kabul kriterleri:**
- [ ] macOS: pencere açılıyor, giriş kalıcı, tema/accent web ile birebir
- [ ] macOS: menü çubuğundan 2 sn'de not düşülüyor (uygulama penceresi kapalıyken de)
- [ ] iOS: uygulama açılıyor, klavye/safe-area düzgün, dikte ve dokunmatik editör çalışıyor
- [ ] iOS: Safari'den bir sayfayı "defter'e paylaş" → günlük nota URL+başlık düşüyor
- [ ] Her iki platformda dış linkler sistem tarayıcısında açılıyor

---

## Genel kurallar (her faz için)

1. **Sıfır npm bağımlılığı** sunucu ve istemcide mutlak kural. Host araçları (rclone, Xcode) serbest.
2. Her faz ayrı branch + küçük commit'ler; merge öncesi `node scripts/smoke.mjs` yeşil.
3. Şema değişen fazlarda (3, 7) deploy öncesi DB yedeği (Faz 1 scripti).
4. Deploy sonrası canlı doğrulama: healthz + tarayıcıyla ilgili akışı gerçekten kullan.
5. UI eklerken mevcut desenleri yeniden kullan: `openPicker`, `toast`, `mini-menu`, ikon seti,
   CSS token'ları. Yeni renk/spacing değeri icat etme.
6. Senkron çekirdeğine (`syncUser`, `collectClientItems`, tombstone) dokunan her değişiklikte
   smoke'taki 3-4. bölümlerin geçtiğini özellikle doğrula.
7. Kullanıcıya sorulacaklar işaretli: R2 anahtarları (Faz 1), Apple Developer hesabı (Faz 8),
   iPhone testleri (Faz 5, 7, 8).
