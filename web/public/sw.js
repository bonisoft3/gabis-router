// Service worker for the rsrouter PWA.
//
// Caches the app shell (HTML, JS, CSS, WASM, icons) so the installed app opens offline.
// Routing data (.rd5, .brf, .dat) and map tiles are cached explicitly by the app itself
// in the segment and map-tile caches, so this worker does not touch those requests.

// Both values are replaced at build time by the `sw-precache` plugin in vite.config.ts.
// In dev mode they stay as-is and the app shell is cached at runtime instead.
const APP_CACHE_VERSION = 'dev';
const PRECACHE_URLS = [];

const APP_CACHE = `rsrouter-app-${APP_CACHE_VERSION}`;
const VALID_CACHES = new Set([APP_CACHE, 'rsrouter-segments-v2', 'rsrouter-map-tiles-v1']);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(APP_CACHE)
      .then((cache) => cache.addAll(['/', ...PRECACHE_URLS]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !VALID_CACHES.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isDataRequest(url) {
  return (
    url.pathname.endsWith('.rd5') ||
    url.pathname.endsWith('.brf') ||
    url.pathname.endsWith('.dat') ||
    url.pathname.endsWith('.pmtiles')
  );
}

// How long a navigation waits for the network before using the cached page.
// Keeps the app fast on weak connections where requests hang instead of failing.
const NAVIGATION_TIMEOUT_MS = 3000;

// The app shell is precached by plain requests. Module scripts are requested with an Origin
// header, so a server that sends `Vary: Origin` would make every lookup miss. Ignore Vary.
async function networkFirst(request, fallbackUrl, timeoutMs) {
  const cache = await caches.open(APP_CACHE);
  const key = fallbackUrl || request;
  const fromCache = () => cache.match(key, { ignoreSearch: !!fallbackUrl, ignoreVary: true });

  const network = fetch(request).then(async (response) => {
    if (response.ok) {
      await cache.put(key, response.clone());
    }
    return response;
  });

  let response;
  try {
    if (timeoutMs) {
      // If the cached page is served after the timeout, this request keeps running and only
      // refreshes the cache. Its failure is then expected and has nobody waiting on it.
      network.catch(() => {});
      const timeout = new Promise((resolve) => setTimeout(resolve, timeoutMs, null));
      response = await Promise.race([network, timeout]);
      // Timed out: use the cached copy if there is one, otherwise keep waiting.
      if (response === null) {
        response = (await fromCache()) || (await network);
      }
    } else {
      response = await network;
    }
  } catch (err) {
    const cached = await fromCache();
    if (cached) return cached;
    throw err;
  }

  // Server errors (for example 502 while the site is down) must not replace a working app.
  if (!response.ok) {
    const cached = await fromCache();
    if (cached) return cached;
  }
  return response;
}

async function cacheFirst(request) {
  const cache = await caches.open(APP_CACHE);
  const cached = await cache.match(request, { ignoreVary: true });
  if (cached) {
    return cached;
  }
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isDataRequest(url)) return;

  if (request.mode === 'navigate') {
    // Single page app: every navigation is served by index.html.
    event.respondWith(networkFirst(request, '/', NAVIGATION_TIMEOUT_MS));
  } else if (url.pathname.startsWith('/assets/')) {
    // Hashed build output never changes for a given URL.
    event.respondWith(cacheFirst(request));
  } else {
    event.respondWith(networkFirst(request));
  }
});
