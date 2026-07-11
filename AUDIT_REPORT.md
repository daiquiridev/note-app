# defter. — Proje Denetim Raporu

**Tarih:** 2026-07-11 · **Kapsam:** code-health (backend + frontend performans/bellek) · **Stack:** sıfır bağımlılıklı Node.js (`node:sqlite`) + tek dosya vanilla JS frontend + Cloudflare Worker (STT)

**Teşhis araçları:** `node --check` (5/5 dosya temiz — server.js, index/login/reset içi JS, worker). Linter/test altyapısı yok (package.json yok, tasarım gereği).

---

## Yüksek

```
[YÜKSEK · KESİN] public/index.html:~1731 (makeMeetRecorder) — MediaRecorder timeslice parçaları bağımsız dosya değil
   Sorun: rec.start(8000) ile üretilen parçalarda yalnızca İLK blob tam bir WebM dosyasıdır
   (EBML/container başlığı içerir); 2. ve sonraki bloblar aynı akışın devam cluster'larıdır ve
   tek başına decode edilemez. Her parça bağımsız olarak Whisper'a gönderiliyor.
   Etki: İlk 8 saniye düzgün çözülür, sonraki parçalar bozuk/eksik metin üretir ya da sessizce
   başarısız olur — kullanıcının bildirdiği "bölük bölük çalışıyor" belirtisiyle birebir uyumlu.
   Çözüm yönü: her parça için recorder'ı durdurup yeniden başlatmak (stop→start döngüsü, her
   ondataavailable bloğu kendi başına tam dosya olur) ya da parçaları birleştirip göndermek.

[YÜKSEK · KESİN] git — 183 satırlık commit'lenmemiş değişiklik + repo/prod uyumsuzluğu
   Sorun: Blok tutamağı (sürükle-bırak), toggle/girinti ve "yazarken senkron state değişimi
   veri kaybettiriyor" düzeltmesi dahil son değişiklikler working tree'de duruyor; son commit
   (9fd9b9b) bunları içermiyor. Prod'a scp ile deploy edilen kod repo'nun önünde.
   Etki: Kullanıcı başka cihazdan devam etmeyi planlıyor — push edilmezse bu iş o cihazda yok;
   veri-kaybı düzeltmesi gibi kritik bir yama yalnızca prod kopyasında ve tek makinede yaşıyor.
```

## Orta

```
[ORTA · KESİN] server.js:894-905 — OAuth token tablosunda temizlik ve refresh rotation yok
   Sorun: (a) Her token yenilemede yeni access token satırı ekleniyor ama süresi dolanlar hiç
   silinmiyor (DELETE yok); oauth_codes ve password_resets için de temizlik yok → sınırsız
   tablo büyümesi. (b) Refresh token süresiz ve hiç döndürülmüyor (rotation yok) — public
   client'ta çalınan refresh token kalıcı erişim verir (RFC 9700 rotation önerir).
   Etki: Uzun vadede DB şişmesi; refresh token sızarsa fark edilmesi/iptali zor.

[ORTA · ŞÜPHELİ] server.js:593-596 (renderIndex) — String.replace + JSON.stringify şablonlama
   Sorun: (a) replace'in ikinci argümanındaki "$&", "$'" gibi kalıplar işlenir — proje adı/e-posta
   "$" içerirse sayfa bozulur. (b) JSON.stringify "</script>" dizisini kaçırmaz; proje adı
   "</script><script>..." içerirse script bloğundan kaçış (stored XSS) mümkün.
   Neden şüpheli: proje adı şu an yalnızca sunucu CLI'siyle (project-link) set ediliyor — saldırı
   yüzeyi fiilen kapalı (self-XSS). UI'dan/MCP'den ad düzenleme eklenirse gerçek açığa dönüşür.
   Çözüm yönü: replace yerine split/join, ve "<" karakterini < olarak kaçır.

[ORTA · KESİN] proje geneli — Test altyapısı hiç yok
   Sorun: Sync/tombstone birleştirme, OAuth akışı, proje taşıma gibi veri-kritik mantığın hiçbiri
   test edilmiyor. Bu oturumda üç ayrı veri kaybı riski elle yakalandı (login-proje seçimi,
   senkron sırasında state değişimi, sort yan etkisi) — hepsi birim testiyle yakalanabilirdi.
   Etki: Her refactor "notlarım kayboldu" riskini yeniden açıyor.

[ORTA · ŞÜPHELİ] public/index.html (cloudPush/save) — Tam-state senkron modeli büyük notlarda jank
   Sorun: Her kayıtta tüm state localStorage'a JSON.stringify ediliyor ve her push TÜM veriyi
   (base64 görseller dahil) sunucuya gönderiyor. 25MB'a varan state'te yazarken ana thread
   duraksamaları ve gereksiz bant genişliği olası.
   Neden şüpheli: mevcut veri hacmi küçük; sorun ancak görsel ağırlıklı kullanımda ortaya çıkar.

[ORTA · ŞÜPHELİ] public/index.html (appendLabeledTranscript) — Kapalı toggle + canlı transkript etkileşimi
   Sorun: Not sonuna eklenen transkript bloğu DOM'a doğrudan appendChild ediliyor; notun sonu
   kapalı bir toggle'ın kapsamındaysa blok mantıksal olarak gizli bölgeye düşer — bir sonraki
   rerender'da ekrandan kaybolur ("yazdı ama uçtu" izlenimi).
```

## Düşük

```
[DÜŞÜK · KESİN] public/index.html:962, 2469 — state.notes.sort() yerinde mutasyon
   Sorun: "En son güncellenen notu bul" amaçlı sort, saklanan dizinin sırasını kalıcı değiştiriyor
   (yan etki). Render zaten kendi sıralamasını yaptığı için görünür zarar yok ama saklanan veri
   sırası her silme/hydrate'te sessizce değişiyor. [...state.notes].sort(...) yeterli.

[DÜŞÜK · KESİN] workers/stt/src/index.js:6 — Bearer secret karşılaştırması timing-safe değil
   Sorun: auth !== `Bearer ${env.STT_SECRET}` düz karşılaştırma. 64-hex rastgele secret + HTTPS
   ile pratik sömürü olasılığı çok düşük; yine de crypto.subtle.timingSafeEqual tercih edilir.

[DÜŞÜK · KESİN] workers/stt/src/index.js:22 — Hata detayı istemciye sızıyor
   Sorun: catch bloğu String(e) döndürüyor; iç hata mesajları (model/binding detayı) dışarı çıkar.

[DÜŞÜK · KESİN] Dockerfile — Container root kullanıcıyla çalışıyor
   Sorun: USER node yok; port 80'i root dinliyor. Alpine node imajında hazır "node" kullanıcısı var.

[DÜŞÜK · KESİN] repo — README yok
   Sorun: Kurulum, deploy akışı ve kritik CLI komutları (login-adopt, project-link, mcp-key-add,
   mcp-key-revoke) repoda dokümante değil; bilgi yalnızca Claude memory dosyalarında yaşıyor.

[DÜŞÜK · ŞÜPHELİ] public/index.html (deleteNote/undoBuf) — Tek slotluk undo tamponu
   Sorun: undoBuf global tek değer; art arda iki not silinirse ilk toast'un "Geri Al" düğmesi
   ikinci silmenin verisini/indeksini kullanır. Kısa toast ömrü nedeniyle pencere dar.

[DÜŞÜK · KESİN] public/index.html:500 — transition:all (accent renk yuvarlağı)
   Sorun: Tarayıcı tüm property'leri izler; tek öğe olduğu için etkisi önemsiz, yine de
   yalnızca değişen property (transform/border-color) belirtilmeli.
```

## Olumlu Tespitler

- `crypto.timingSafeEqual` hem parola hash hem oturum token doğrulamasında kullanılıyor (server.js:138, 642).
- Rate limiting dört hassas uçta da var: `/api/login`, `/api/forgot`, `/register`, `/token`.
- Cookie'ler `HttpOnly; Secure; SameSite=Lax` — CSRF için makul temel koruma.
- Login `return` parametresinde open-redirect koruması var (login.html:78-84).
- OAuth'ta PKCE (S256) zorunlu; kodlar/token'lar DB'de SHA-256 hash'li saklanıyor.
- Repoda hiçbir secret yok; `.gitignore` doğru (.env, *.db*, .wrangler).
- WAL modu + busy_timeout ayarlı; tüm çok-adımlı DB yazımları BEGIN/COMMIT/ROLLBACK içinde.

---

## ÖZET TABLO

| Önem | Adet |
|---|---|
| Kritik | 0 |
| Yüksek | 2 |
| Orta | 5 |
| Düşük | 7 |
| **Toplam** | **14** |

### En acil 5 madde
1. **Commit'lenmemiş 183 satırı push et** — başka cihaza geçmeden önce; veri-kaybı düzeltmesi dahil.
2. **MediaRecorder chunk hatası** — toplantı transkripsiyonunun "bölük bölük" çalışmasının kök nedeni; parça başına recorder restart.
3. **OAuth token temizliği + refresh rotation** — DB büyümesi ve kalıcı erişim riski.
4. **renderIndex şablon kaçışı** — `</script>` ve `$` kaçışı; ilerideki "proje adını UI'dan düzenle" özelliğinden önce kapatılmalı.
5. **Sync/tombstone mantığına birim test** — üç kez elle yakalanan veri kaybı sınıfını kalıcı güvenceye al.

### Hızlı Kazanımlar (düşük efor → yüksek etki)
- `git add -A && git commit && git push` (2 dk)
- `/token` handler'ına tek satır: `DELETE FROM oauth_tokens WHERE expires IS NOT NULL AND expires < ?` (5 dk)
- `state.notes.sort` → `[...state.notes].sort` (2 yer, 2 dk)
- Dockerfile'a `USER node` (+ port>1024 veya cap ekle) (5 dk)
- Worker'da `String(e)` → sabit "STT hatası" mesajı (2 dk)
- Kısa bir README (kurulum + CLI komutları) (15 dk)
