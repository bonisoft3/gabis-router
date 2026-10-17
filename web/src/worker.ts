import type { RouteResponse, WorkerMessage, LatLon } from './types.ts';
import init, { WasmRouter } from './pkg/rsrouter_wasm.js';
import { SEGMENT_CACHE_NAME, MIN_RD5_BYTES, fetchAndCacheSegment, isHtml } from './segment-cache.ts';

// Dedicated Web Worker running rsrouter WebAssembly off the main UI thread.
// Uses BRouter-style lazy on-demand MicroCache cell loading via disk-backed Blob.slice + FileReaderSync.

const PROFILES = ['fastbike-lowtraffic', 'fastbike', 'fastbike-verylowtraffic', 'gabis-fast-city', 'gabis-lite-gravel', 'gabis-safe-road', 'gravel', 'trekking'];
const MAX_CACHED_CELLS = 2500;

let router: WasmRouter | null = null;
let isOfflineMode = false;
const latestSlotRouteIds = new Map<number, string>();
let latestImportId: string | null = null;

// Disk-backed Blob handles for 5°×5° .rd5 files (0 bytes of JS heap per file until a slice is read).
const segmentBlobs = new Map<string, Blob>();
const failedSegments = new Set<string>();
const fileReaderSync = new FileReaderSync();

function status(message: string) {
  postMessage({ type: 'STATUS', message } satisfies WorkerMessage);
}

/**
 * Network-first fetch for small text files (lookups and profiles) with cache fallback.
 */
async function fetchText(url: string): Promise<string> {
  const cache = await caches.open(SEGMENT_CACHE_NAME);
  if (!isOfflineMode && navigator.onLine) {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
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
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok || isHtml(res)) {
    throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  }
  await cache.put(url, res.clone());
  return res.text();
}

function segmentName(lon: number, lat: number): string {
  const baseLon = Math.floor(lon / 5) * 5;
  const baseLat = Math.floor(lat / 5) * 5;
  const slon = baseLon < 0 ? `W${-baseLon}` : `E${baseLon}`;
  const slat = baseLat < 0 ? `S${-baseLat}` : `N${baseLat}`;
  return `${slon}_${slat}`;
}

/**
 * Opens a zero-copy disk-backed Blob reference to `/segments4/<segmentName>.rd5` in CacheStorage,
 * downloading and caching it first if not yet present.
 */
async function openSegmentBlob(name: string, required: boolean): Promise<boolean> {
  if (segmentBlobs.has(name)) {
    return true;
  }
  if (!required && failedSegments.has(name)) {
    return false;
  }

  const key = `/segments4/${name}.rd5`;
  const cache = await caches.open(SEGMENT_CACHE_NAME);
  const cached = await cache.match(key);
  if (cached && !isHtml(cached)) {
    const blob = await cached.blob();
    if (blob.size >= MIN_RD5_BYTES) {
      segmentBlobs.set(name, blob);
      failedSegments.delete(name);
      return true;
    }
    await cache.delete(key);
  }

  if (isOfflineMode) {
    failedSegments.add(name);
    if (required) {
      throw new Error(`Routing data ${name} is not downloaded for offline use`);
    }
    return false;
  }

  try {
    status(`Fetching ${name}.rd5...`);
    const bytes = await fetchAndCacheSegment(name, (received, total) => {
      const mb = (received / (1024 * 1024)).toFixed(1);
      const totMb = total > 0 ? (total / (1024 * 1024)).toFixed(1) : '?';
      status(`Downloading ${name}.rd5 (${mb} / ${totMb} MB)...`);
    });
    const freshCached = await cache.match(key);
    const blob = freshCached ? await freshCached.blob() : new Blob([bytes as BlobPart]);
    segmentBlobs.set(name, blob);
    failedSegments.delete(name);
    return true;
  } catch (err) {
    failedSegments.add(name);
    if (required) throw err;
    console.warn(`Skipping border segment ${name}:`, err);
    return false;
  }
}

/**
 * Loads WASM, lookups, profiles, and attaches the synchronous Blob.slice reader callbacks.
 */
async function ensureRouter(): Promise<WasmRouter> {
  if (router) return router;

  status('Initializing WebAssembly engine...');
  await init();
  const r = new WasmRouter();

  r.set_segment_reader(
    (name: string): number => {
      const blob = segmentBlobs.get(name);
      return blob ? blob.size : 0;
    },
    (name: string, start: number, end: number): Uint8Array => {
      const blob = segmentBlobs.get(name);
      if (!blob) return new Uint8Array(0);
      const buf = fileReaderSync.readAsArrayBuffer(blob.slice(start, end));
      return new Uint8Array(buf);
    },
  );

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
 * Executes an operation on `WasmRouter` with lazy on-demand cell loading. If the search touches
 * a 5°×5° segment boundary whose Blob has not been opened yet, opens the missing segment Blob(s)
 * and re-runs the operation once.
 */
async function runWithLazySegments<T>(
  r: WasmRouter,
  initialPoints: LatLon[],
  op: () => T,
): Promise<T> {
  if (r.loaded_cell_count() > MAX_CACHED_CELLS) {
    r.clear_graph();
  }

  const requiredSegments = new Set(initialPoints.map((w) => segmentName(w.lon, w.lat)));
  for (const seg of requiredSegments) {
    await openSegmentBlob(seg, true);
  }

  const nearbySegments = new Set<string>();
  for (const w of initialPoints) {
    for (const dLon of [-0.15, 0, 0.15]) {
      for (const dLat of [-0.15, 0, 0.15]) {
        const seg = segmentName(w.lon + dLon, w.lat + dLat);
        if (!requiredSegments.has(seg)) {
          nearbySegments.add(seg);
        }
      }
    }
  }
  for (const seg of nearbySegments) {
    await openSegmentBlob(seg, false);
  }

  r.take_missing_segments();

  while (true) {
    let result: T | undefined;
    let opErr: unknown = null;
    try {
      result = op();
    } catch (err) {
      opErr = err;
      const msg = String(err);
      if (msg.includes('unreachable') || msg.includes('recursive use of an object')) {
        router = null;
        throw err;
      }
    }

    const missing = r.take_missing_segments();
    let openedAny = false;
    for (const seg of missing) {
      if (await openSegmentBlob(seg, false)) {
        openedAny = true;
      }
    }

    if (openedAny) {
      r.clear_graph();
      continue;
    }
    if (opErr !== null) {
      throw opErr;
    }
    return result as T;
  }
}

function extractGpxTrackPoints(gpxXml: string): LatLon[] {
  for (const tag of ['trkpt', 'rtept', 'wpt']) {
    const pts: LatLon[] = [];
    const tagRe = new RegExp(`<${tag}\\s+([^>]+)>`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(gpxXml)) !== null) {
      const attrs = m[1];
      const latMatch = /lat\s*=\s*["']([^"']+)["']/i.exec(attrs);
      const lonMatch = /lon\s*=\s*["']([^"']+)["']/i.exec(attrs);
      if (latMatch && lonMatch) {
        const lat = Number(latMatch[1]);
        const lon = Number(lonMatch[1]);
        if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
          pts.push({ lat, lon });
        }
      }
    }
    if (pts.length >= 2) return pts;
  }
  return [];
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
      const slotIdx = msg.slotIdx ?? 0;
      if (latestSlotRouteIds.get(slotIdx) !== msg.id) return;
      try {
        const r = await ensureRouter();
        if (latestSlotRouteIds.get(slotIdx) !== msg.id) return;
        const { waypoints, profile, alternativeIdx, nogos } = msg.payload;
        const waypointsStr = waypoints.map((w) => `${w.lon},${w.lat}`).join('|');
        const nogosStr =
          nogos && nogos.length > 0
            ? nogos
                .map(
                  (n) =>
                    `${n.lon},${n.lat},${n.radius}${n.weight !== undefined ? ',' + n.weight : ''}`,
                )
                .join('|')
            : undefined;

        status(`Calculating route (${waypoints.length} points, ${profile})...`);
        const geojsonStr = await runWithLazySegments(r, waypoints, () =>
          r.find_route(waypointsStr, profile, alternativeIdx ?? 0, nogosStr),
        );
        if (latestSlotRouteIds.get(slotIdx) !== msg.id) return;

        const response: RouteResponse = JSON.parse(geojsonStr);
        postMessage({
          type: 'ROUTE_SUCCESS',
          id: msg.id,
          slotIdx,
          payload: response,
        } satisfies WorkerMessage);
      } catch (err) {
        postMessage({
          type: 'ROUTE_ERROR',
          id: msg.id,
          slotIdx,
          error: String(err),
        } satisfies WorkerMessage);
      }
      break;
    }

    case 'IMPORT_GPX_REQUEST': {
      if (msg.id !== latestImportId) return;
      try {
        const r = await ensureRouter();
        if (msg.id !== latestImportId) return;
        const { gpxXml, profile, toleranceM } = msg.payload;
        const trackPoints = extractGpxTrackPoints(gpxXml);
        if (trackPoints.length < 2) {
          throw new Error('GPX document must contain at least 2 valid track, route, or waypoint coordinates.');
        }

        status(`Matching GPX track (${trackPoints.length} points, ${profile})...`);
        const rawJson = await runWithLazySegments(r, trackPoints, () =>
          r.match_gpx_waypoints(gpxXml, profile, toleranceM ?? 20.0),
        );
        if (msg.id !== latestImportId) return;

        const parsed = JSON.parse(rawJson) as { waypoints: LatLon[]; route: RouteResponse };
        postMessage({
          type: 'IMPORT_GPX_SUCCESS',
          id: msg.id,
          payload: parsed,
        } satisfies WorkerMessage);
      } catch (err) {
        postMessage({ type: 'ROUTE_ERROR', id: msg.id, error: String(err) } satisfies WorkerMessage);
      }
      break;
    }

    case 'CLEAR_GRAPH': {
      try {
        router?.clear_graph();
      } catch {
        router = null;
      }
      segmentBlobs.clear();
      failedSegments.clear();
      break;
    }
  }
}

let queue: Promise<void> = Promise.resolve();

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;
  if (msg.type === 'SET_OFFLINE_MODE') {
    if (isOfflineMode !== msg.offline) {
      failedSegments.clear();
    }
    isOfflineMode = msg.offline;
    return;
  }
  if (msg.type === 'ROUTE_REQUEST') {
    latestSlotRouteIds.set(msg.slotIdx ?? 0, msg.id);
  } else if (msg.type === 'IMPORT_GPX_REQUEST') {
    latestImportId = msg.id;
    latestSlotRouteIds.clear();
  }
  queue = queue.then(() => handleMessage(msg));
};

