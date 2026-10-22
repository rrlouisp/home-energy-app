// Home Energy: keeps the page working offline, and shows push notifications once they're set up.
const SHELL = "home-energy-shell-v3";
const DATA = "home-energy-data";
const FILES = ["./", "index.html", "setup.html", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== DATA).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;     // e.g. the private figures from GitHub: never cached here
  if (url.pathname.endsWith("app-data.json")) {
    // the figures: always try the network first, fall back to the last copy
    event.respondWith(fetch(event.request).then(response => {
      const copy = response.clone();
      caches.open(DATA).then(cache => cache.put(event.request, copy));
      return response;
    }).catch(() => caches.match(event.request)));
    return;
  }
  // the page itself: the saved copy straight away, refreshed in the background
  event.respondWith(caches.match(event.request).then(saved => {
    const fresh = fetch(event.request).then(response => {
      if (response.ok) caches.open(SHELL).then(cache => cache.put(event.request, response.clone()));
      return response;
    }).catch(() => saved);
    return saved || fresh;
  }));
});

self.addEventListener("push", event => {
  // Declarative Web Push ({"web_push": 8030, "notification": {...}}) or a plain {"title", "body"}
  let message = { title: "Home energy", body: "", navigate: "./" };
  try {
    const data = event.data ? event.data.json() : {};
    message = Object.assign(message, data.notification || data);
  } catch (e) { message.body = event.data ? event.data.text() : ""; }
  event.waitUntil(Promise.all([
    self.registration.showNotification(message.title || "Home energy", {
      body: message.body, icon: "icon-192.png", badge: "icon-192.png", tag: message.tag || undefined,
      data: { navigate: message.navigate || "./" },
    }),
    caches.open(DATA).then(cache => cache.put("last-alert",
      new Response(JSON.stringify({ at: Date.now(), body: message.body }), { headers: { "Content-Type": "application/json" } }))),
  ]));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.navigate) || "./";
  event.waitUntil(self.clients.matchAll({ type: "window" }).then(list =>
    list.length ? list[0].focus() : self.clients.openWindow(target)));
});
