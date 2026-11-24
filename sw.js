/* GHOST Service Worker — Static App Shell & Network Boundaries */
const CACHE_NAME = "ghost-shell-v4";
const APP_SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./manifest.json"];
const BYPASS_HOSTS = [
  "supabase.co",
  "supabase.in",
  "nominatim.openstreetmap.org",
  "photon.komoot.io",
  "router.project-osrm.org"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(APP_SHELL).catch(() => undefined)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || BYPASS_HOSTS.some((h) => url.hostname.endsWith(h))) {
    return;
  }

  if (request.mode === "navigate") {
    e.respondWith(
      fetch(request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put("./index.html", copy));
          }
          return res;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  if (
    url.hostname.includes("unpkg.com") ||
    url.hostname.includes("cdn.jsdelivr.net") ||
    url.hostname.includes("fonts.googleapis.com") ||
    url.hostname.includes("fonts.gstatic.com")
  ) {
    e.respondWith(
      caches.match(request).then((cached) => {
        const net = fetch(request)
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(CACHE_NAME).then((c) => c.put(request, copy));
            }
            return res;
          })
          .catch(() => cached);
        return cached || net;
      })
    );
  }
});
