const CACHE_NAME = "quran-reader-static-v12";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./reader.js",
  "./reader-state.js",
  "./reading-data.js",
  "./preferences-store.js",
  "./translation-repository.js",
  "./quran-data.js",
  "./en.hilali.txt",
  "./favicon.svg",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith("quran-reader-static-") && key !== CACHE_NAME).map(key => caches.delete(key)),
  )).then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  const updateWhenOnline = request.mode === "navigate" || ["script", "style"].includes(request.destination);
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (!updateWhenOnline && cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok) {
        const copy = response.clone();
        await caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
      }
      return response;
    } catch (error) {
      if (cached) return cached;
      if (request.mode === "navigate") {
        const fallback = await caches.match(new URL("./", self.registration.scope).toString());
        if (fallback) return fallback;
      }
      throw error;
    }
  })());
});
