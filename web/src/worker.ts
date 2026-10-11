import type { RouteResponse, WorkerMessage, LatLon } from './types.ts';
import init, { WasmRouter } from './pkg/rsrouter_wasm.js';

// Dedicated Web Worker running rsrouter WebAssembly off the main UI thread.
// Messages are handled one at a time, so a route request never sees a half-loaded graph.

const CACHE_NAME = 'rsrouter-segments-v2';
const MIN_RD5_BYTES = 50000;
const PROFILES = ['fastbike-lowtraffic', 'fastbike', 'fastbike-verylowtraffic', 'gabis-lite-gravel', 'gabis-safe-road', 'gravel', 'trekking'];

let router: WasmRouter | null = null;
let isOfflineMode = false;
let latestRouteId: string | null = null;

// BRouter loads 1/80° cells lazily as the search reaches them, so it has no bounding box.
// Our graph is built before the search, so we load the waypoints' bounding box plus a margin,
// and retry with a wider margin if no route is found inside it.
const MIN_MARGIN_KM = 5;
const MARGIN_FRACTION = 0.2; // of the bounding box diagonal
const MARGIN_RETRY_FACTOR = 3;
const MAX_MARGIN_KM = 60;

interface Box {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

let loadedBox: Box | null = null;

function status(message: string) {
  postMessage({ type: 'STATUS', message } satisfies WorkerMessage);
}

// Vite and static hosts answer unknown paths with index.html and HTTP 200.
function isHtml(res: Response): boolean {
  return (res.headers.get('content-type') || '').includes('text/html');
}

/**
 * Network-first fetch for small text files (lookups and profiles) with cache fallback.
 */
async function fetchText(url: string): Promise<string> {
  const cache = await caches.open(CACHE_NAME);
  if (!isOfflineMode && navigator.onLine) {
    try {
      const res = await fetch(url);
      if (res.ok && !isHtml(res)) {
        await cache.put(url, res.clone());
        return await res.text();
      }
    } catch (_err) {
      // fallback to cache below
    }
  }
  const cached = await cache.match(url);
  if (cached && !isHtml(cached)) {
    return cached.text();
  }
  const res = await fetch(url);
  if (!res.ok || isHtml(res)) {
    throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  }
  await cache.put(url, res.clone());
  return res.text();
}

async function readWithProgress(res: Response, fileName: string): Promise<Uint8Array<ArrayBuffer>> {
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let lastReport = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    const now = Date.now();
    if (now - lastReport > 250) {
      lastReport = now;
      const recMb = (received / (1024 * 1024)).toFixed(1);
      const totMb = total > 0 ? (total / (1024 * 1024)).toFixed(1) : '?';
      status(`Downloading ${fileName}: ${recMb} / ${totMb} MB...`);
    }
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Returns the raw RD5 segment bytes. Every segment is cached under /segments4/<name>.rd5,
 * whether it came from the local server or from brouter.de.
 */
async function getSegmentBytes(segmentName: string): Promise<Uint8Array> {
  const key = `/segments4/${segmentName}.rd5`;
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(key);
  if (cached) {
    const buf = await cached.arrayBuffer();
    if (!isHtml(cached) && buf.byteLength >= MIN_RD5_BYTES) {
      return new Uint8Array(buf);
    }
    await cache.delete(key);
  }

  if (isOfflineMode) {
    throw new Error(`Routing data ${segmentName} is not downloaded for offline use`);
  }

  let res = await fetch(key);
  if (!res.ok || isHtml(res)) {
    status(`Fetching ${segmentName}.rd5 from brouter.de...`);
    res = await fetch(`/remote-segments/${segmentName}.rd5`);
  }
  if (!res.ok || isHtml(res)) {
    throw new Error(`Routing data ${segmentName} is not available: HTTP ${res.status}`);
  }

  const bytes = await readWithProgress(res, `${segmentName}.rd5`);
  if (bytes.byteLength < MIN_RD5_BYTES) {
    throw new Error(`Routing data ${segmentName} is too small (${bytes.byteLength} bytes)`);
  }
  await cache.put(
    key,
    new Response(bytes, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.byteLength),
      },
    }),
  );
  return bytes;
}

function segmentName(lon: number, lat: number): string {
  const baseLon = Math.floor(lon / 5) * 5;
  const baseLat = Math.floor(lat / 5) * 5;
  const slon = baseLon < 0 ? `W${-baseLon}` : `E${baseLon}`;
  const slat = baseLat < 0 ? `S${-baseLat}` : `N${baseLat}`;
  return `${slon}_${slat}`;
}

/** The 5°×5° segments that overlap the box. */
function segmentsForBox(box: Box): string[] {
  const names: string[] = [];
  for (let lon = Math.floor(box.minLon / 5) * 5; lon <= box.maxLon; lon += 5) {
    for (let lat = Math.floor(box.minLat / 5) * 5; lat <= box.maxLat; lat += 5) {
      names.push(segmentName(lon, lat));
    }
  }
  return names;
}

function waypointBox(waypoints: LatLon[]): Box {
  const lons = waypoints.map((w) => w.lon);
  const lats = waypoints.map((w) => w.lat);
  return {
    minLon: Math.min(...lons),
    minLat: Math.min(...lats),
    maxLon: Math.max(...lons),
    maxLat: Math.max(...lats),
  };
}

function kmPerDegreeLon(lat: number): number {
  return 111.32 * Math.cos((lat * Math.PI) / 180);
}

function boxDiagonalKm(box: Box): number {
  const midLat = (box.minLat + box.maxLat) / 2;
  const dx = (box.maxLon - box.minLon) * kmPerDegreeLon(midLat);
  const dy = (box.maxLat - box.minLat) * 110.57;
  return Math.hypot(dx, dy);
}

function padBox(box: Box, marginKm: number): Box {
  // Use the latitude closest to the pole, where a degree of longitude is shortest.
  const lat = Math.max(Math.abs(box.minLat), Math.abs(box.maxLat));
  const dLon = marginKm / kmPerDegreeLon(lat);
  const dLat = marginKm / 110.57;
  return {
    minLon: box.minLon - dLon,
    minLat: box.minLat - dLat,
    maxLon: box.maxLon + dLon,
    maxLat: box.maxLat + dLat,
  };
}

function boxContains(outer: Box, inner: Box): boolean {
  return (
    outer.minLon <= inner.minLon &&
    outer.minLat <= inner.minLat &&
    outer.maxLon >= inner.maxLon &&
    outer.maxLat >= inner.maxLat
  );
}

/**
 * Loads WASM, lookups and all profiles. Only sets `router` once everything succeeded,
 * so a failed init (for example while offline) is retried on the next request.
 */
async function ensureRouter(): Promise<WasmRouter> {
  if (router) return router;

  status('Initializing WebAssembly engine...');
  await init();
  const r = new WasmRouter();

  status('Loading lookups dictionary...');
  r.load_lookups(await fetchText('/profiles/lookups.dat'));

  for (const p of PROFILES) {
    status(`Loading profile ${p}...`);
    r.load_profile(p, await fetchText(`/profiles/${p}.brf`));
  }

  router = r;
  return r;
}

/**
 * Makes sure the graph covers `box`. If not, the graph is rebuilt with exactly this box,
 * so memory use stays bounded across many routes. Segments holding a waypoint must load.
 * Segments that only cover the margin are skipped if unavailable: sea, or not downloaded.
 */
async function ensureBoxLoaded(r: WasmRouter, box: Box, required: Set<string>): Promise<void> {
  if (loadedBox && boxContains(loadedBox, box)) {
    return;
  }

  r.clear_graph();
  loadedBox = null;

  try {
    for (const name of segmentsForBox(box)) {
      status(`Loading routing data ${name}...`);
      let bytes: Uint8Array;
      try {
        bytes = await getSegmentBytes(name);
      } catch (err) {
        if (required.has(name)) throw err;
        console.warn(`Skipping margin segment ${name}:`, err);
        continue;
      }
      status(`Decoding ${name}...`);
      r.add_rd5_box(bytes, name, box.minLon, box.minLat, box.maxLon, box.maxLat);
    }
    status('Resolving road graph connections...');
    r.resolve_graph();
  } catch (err) {
    r.clear_graph();
    throw err;
  }

  loadedBox = box;
  status(`Graph ready: ${r.node_count().toLocaleString()} nodes, ${r.edge_count().toLocaleString()} edges.`);
}

async function handleMessage(msg: WorkerMessage): Promise<void> {
  switch (msg.type) {
    case 'INIT': {
      try {
        await ensureRouter();
        status('Router ready. Click on the map to set waypoints.');
      } catch (err) {
        status(`Initialization failed: ${String(err)}`);
      }
      break;
    }

    case 'ROUTE_REQUEST': {
      // A newer request arrived while this one was queued. Skip it.
      if (msg.id !== latestRouteId) return;
      try {
        const r = await ensureRouter();
        const { waypoints, profile, alternativeIdx } = msg.payload;
        if (!isOfflineMode && navigator.onLine) {
          try {
            const profileText = await fetchText(`/profiles/${profile}.brf`);
            r.load_profile(profile, profileText);
          } catch (_e) {
            // ignore reload failure and continue with existing loaded profile
          }
        }
        const waypointsStr = waypoints.map((w) => `${w.lon},${w.lat}`).join('|');
        const required = new Set(waypoints.map((w) => segmentName(w.lon, w.lat)));
        const bbox = waypointBox(waypoints);

        let marginKm = Math.min(MAX_MARGIN_KM, Math.max(MIN_MARGIN_KM, MARGIN_FRACTION * boxDiagonalKm(bbox)));
        let geojsonStr: string;
        while (true) {
          await ensureBoxLoaded(r, padBox(bbox, marginKm), required);
          status(`Calculating route (${waypoints.length} points, ${profile}, ${Math.round(marginKm)} km margin)...`);
          try {
            geojsonStr = r.find_route(waypointsStr, profile, alternativeIdx ?? 0);
            break;
          } catch (err) {
            // A waypoint far from any road is not fixed by loading a wider area.
            if (marginKm >= MAX_MARGIN_KM || /could not be mapped/.test(String(err))) throw err;
            marginKm = Math.min(MAX_MARGIN_KM, marginKm * MARGIN_RETRY_FACTOR);
            status(`No route inside the loaded area. Retrying with a ${Math.round(marginKm)} km margin...`);
          }
        }

        const response: RouteResponse = JSON.parse(geojsonStr);
        postMessage({ type: 'ROUTE_SUCCESS', id: msg.id, payload: response } satisfies WorkerMessage);
      } catch (err) {
        postMessage({ type: 'ROUTE_ERROR', id: msg.id, error: String(err) } satisfies WorkerMessage);
      }
      break;
    }

    case 'CLEAR_GRAPH': {
      router?.clear_graph();
      loadedBox = null;
      break;
    }
  }
}

let queue: Promise<void> = Promise.resolve();

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;
  if (msg.type === 'SET_OFFLINE_MODE') {
    isOfflineMode = msg.offline;
    return;
  }
  if (msg.type === 'ROUTE_REQUEST') {
    latestRouteId = msg.id;
  }
  queue = queue.then(() => handleMessage(msg));
};
