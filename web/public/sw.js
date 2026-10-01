// Service worker for rsrouter PWA offline caching.
// Note: Only caches data tiles and profiles. Never caches application JS or WASM binaries
// to prevent stale binary mismatches.

const CACHE_NAME = 'rsrouter-segments-v2';

self.addEventListener('install', (_event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Cache only segment files, profiles, and dictionaries for offline routing
  if (
    url.pathname.endsWith('.rd5') ||
    url.pathname.endsWith('.brf') ||
    url.pathname.endsWith('.dat')
  ) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) {
          return cached;
        }
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
  }
});
