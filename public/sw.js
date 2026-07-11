/* defter. service worker — yalnızca kimlikten bağımsız statik kabuk dosyalarını cache'ler.
   "/" ve "/not/*" gibi kullanıcıya özel HTML sayfaları HER ZAMAN ağdan gelir. */
const V = "1";
const CACHE = "defter-shell-v" + V;
const SHELL_URLS = ["/login", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL_URLS)));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  if (SHELL_URLS.includes(new URL(e.request.url).pathname)) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
  }
});

/* payload'sız push: yalnızca "uyandırma" sinyali. Bildirim içeriğini kendimiz çekiyoruz —
   RFC 8291 şifrelemesi boş gövdede gerekmiyor, tek kripto işi sunucudaki VAPID imzası. */
self.addEventListener("push", e => {
  e.waitUntil(
    fetch("/api/reminders/pending", { credentials: "include" })
      .then(r => r.ok ? r.json() : { reminders: [] })
      .then(({ reminders }) => Promise.all((reminders || []).map(t =>
        self.registration.showNotification("⏰ defter.", {
          body: t.text, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", tag: "task-" + t.id,
        })
      )))
      .catch(() => {})
  );
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(clients.openWindow("/gorevler"));
});
