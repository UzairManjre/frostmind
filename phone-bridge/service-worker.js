// Minimal app-shell cache so the PWA itself can load offline/on a flaky connection --
// separate from the IndexedDB sensor-reading buffering in js/idb.js, which handles the actual
// offline data path (Phase2 plan §2.4).
// Bumped to v2 when js/geo.js (GPS capture) was added -- the "activate" handler below deletes
// any cache under a stale name, so this bump is what makes an already-installed PWA pick up the
// new file instead of serving a 404/opaque error for it out of a v1 cache that never knew it
// existed.
// v3: UI redesign (new css/style.css + index.html markup).
const CACHE_NAME = "frostmind-bridge-v3";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/style.css",
  "./js/config.js",
  "./js/idb.js",
  "./js/ble.js",
  "./js/api.js",
  "./js/sync.js",
  "./js/wizard.js",
  "./js/dashboard.js",
  "./js/geo.js",
  "./js/app.js",
  "./icons/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  // Network-first for API calls (anything not same-origin, i.e. the backend) so live data is
  // never served stale; cache-first for the app shell itself.
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // let backend requests pass straight through

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
