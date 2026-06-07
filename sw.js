const CACHE_NAME = "padel-club-v8";
const APP_SHELL = [
  "./",
  "./index.html",
  "./admin.html",
  "./login.html",
  "./styles.css",
  "./app.js",
  "./messaging-service.js",
  "./manifest.webmanifest",
  "./assets/gallery/padel-court.png",
  "./assets/gallery/pickleball-courts.png",
  "./assets/gallery/turf-cricket.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("./index.html")));
    return;
  }
  if (event.request.url.includes("config.js")) {
    event.respondWith(fetch(event.request));
    return;
  }
  if (["script", "style"].includes(event.request.destination)) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request)),
    );
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
