import type { RouteResponse, WorkerMessage, LatLon } from './types.ts';
import init, { WasmRouter } from './pkg/rsrouter_wasm.js';

// Dedicated Web Worker running rsrouter WebAssembly off the main UI thread.

const CACHE_NAME = 'rsrouter-segments-v2';

let router: WasmRouter | null = null;
let isInitialized = false;
let isOfflineMode = false;
const loadedProfiles = new Set<string>();
const loadedSquareKeys = new Set<string>();

interface TileSquare {
  segmentName: string;
  lonDeg: number;
  latDeg: number;
  key: string;
}

/**
 * Fetches a URL with persistent caching via the browser CacheStorage API.
 * Validates that responses are genuine binary RD5 segment files before caching.
 */
async function fetchWithCache(
  url: string,
  onStatus?: (msg: string) => void,
): Promise<Uint8Array> {
  const fileName = url.split('/').pop()?.split('?')[0] || url;
  const isRd5 = url.includes('.rd5');
  const minBytes = isRd5 ? 50000 : 50;
  let cache: Cache | null = null;

  try {
    if ('caches' in self) {
      cache = await self.caches.open(CACHE_NAME);
      const cached = await cache.match(url);
      if (cached) {
        const contentType = cached.headers.get('content-type') || '';
        const buf = await cached.arrayBuffer();
        if ((isRd5 && contentType.includes('text/html')) || buf.byteLength < minBytes) {
          // Purge invalid / corrupt cache entry
          await cache.delete(url);
        } else {
          if (onStatus) onStatus(`Retrieved ${fileName} from local browser cache.`);
          return new Uint8Array(buf);
        }
      }
    }
  } catch (err) {
    console.warn('CacheStorage read failed, falling back to network fetch:', err);
  }

  if (onStatus) onStatus(`Starting download of ${fileName}...`);
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`File ${fileName} not found`);
    }
    throw new Error(`Failed to fetch ${fileName}: HTTP ${res.status} ${res.statusText}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (isRd5 && contentType.includes('text/html')) {
    throw new Error(`Invalid response for ${fileName}: received HTML instead of binary segment`);
  }

  // Stream reader to report real-time progress for large files
  const contentLength = Number(res.headers.get('content-length')) || 0;
  const reader = res.body?.getReader();
  let receivedBytes = 0;
  const chunks: Uint8Array[] = [];

  if (reader) {
    let lastReport = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      receivedBytes += value.length;

      const now = Date.now();
      if (onStatus && (now - lastReport > 250 || receivedBytes === contentLength)) {
        lastReport = now;
        if (contentLength > 0) {
          const pct = Math.round((receivedBytes / contentLength) * 100);
          const recMb = (receivedBytes / (1024 * 1024)).toFixed(1);
          const totMb = (contentLength / (1024 * 1024)).toFixed(1);
          onStatus(`Downloading ${fileName}: ${pct}% (${recMb} / ${totMb} MB)...`);
        } else {
          const recMb = (receivedBytes / (1024 * 1024)).toFixed(1);
          onStatus(`Downloading ${fileName}: ${recMb} MB...`);
        }
      }
    }
  } else {
    const rawBuf = await res.arrayBuffer();
    chunks.push(new Uint8Array(rawBuf));
    receivedBytes = rawBuf.byteLength;
  }

  // Combine chunks into a single buffer
  const completeBuffer = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    completeBuffer.set(chunk, offset);
    offset += chunk.length;
  }

  // Validate that file size is realistic
  if (completeBuffer.byteLength < minBytes) {
    throw new Error(`Downloaded file ${fileName} is too small (${completeBuffer.byteLength} bytes)`);
  }

  // Cache only valid binary responses
  if (cache) {
    try {
      await cache.put(
        url,
        new Response(completeBuffer, {
          headers: {
            'content-type': isRd5 ? 'application/octet-stream' : (res.headers.get('content-type') || 'application/octet-stream'),
            'content-length': String(completeBuffer.byteLength),
          },
        }),
      );
      if (onStatus) onStatus(`Cached ${fileName} locally for offline use.`);
    } catch (err) {
      console.warn('CacheStorage write failed:', err);
    }
  }

  return completeBuffer;
}

/**
 * Retrieves the raw RD5 segment bytes, trying local server then remote fallback.
 */
async function getSegmentBytes(
  segmentName: string,
  onProgress?: (msg: string) => void,
): Promise<Uint8Array> {
  // Check CacheStorage first
  if ('caches' in self) {
    try {
      const cache = await self.caches.open(CACHE_NAME);
      for (const candidateUrl of [`/segments4/${segmentName}.rd5`, `/remote-segments/${segmentName}.rd5`]) {
        const cached = await cache.match(candidateUrl);
        if (cached) {
          const contentType = cached.headers.get('content-type') || '';
          const buf = await cached.arrayBuffer();
          if (contentType.includes('text/html') || buf.byteLength < 50000) {
            await cache.delete(candidateUrl);
          } else {
            const sizeMb = (buf.byteLength / (1024 * 1024)).toFixed(1);
            const msg = `Retrieved ${segmentName}.rd5 from local cache (${sizeMb} MB).`;
            if (onProgress) onProgress(msg);
            postMessage({ type: 'STATUS', message: msg });
            return new Uint8Array(buf);
          }
        }
      }
    } catch (err) {
      console.warn('Cache check error:', err);
    }
  }

  // Try local bundled file first
  try {
    return await fetchWithCache(`/segments4/${segmentName}.rd5`, (msg) => {
      if (onProgress) onProgress(msg);
      postMessage({ type: 'STATUS', message: msg });
    });
  } catch (_localErr) {
    if (isOfflineMode) {
      throw new Error(`Segment ${segmentName} is not cached for offline routing`);
    }
    const notifyMsg = `Fetching remote segment ${segmentName} from BRouter...`;
    if (onProgress) onProgress(notifyMsg);
    postMessage({ type: 'STATUS', message: notifyMsg });
    return await fetchWithCache(`/remote-segments/${segmentName}.rd5`, (msg) => {
      if (onProgress) onProgress(msg);
      postMessage({ type: 'STATUS', message: msg });
    });
  }
}

/**
 * Computes the 1°×1° tile squares needed for the bounding box of the given waypoints.
 */
function getSquaresForBoundingBox(waypoints: LatLon[]): TileSquare[] {
  let minLon = waypoints[0].lon;
  let maxLon = waypoints[0].lon;
  let minLat = waypoints[0].lat;
  let maxLat = waypoints[0].lat;

  for (const wp of waypoints) {
    if (wp.lon < minLon) minLon = wp.lon;
    if (wp.lon > maxLon) maxLon = wp.lon;
    if (wp.lat < minLat) minLat = wp.lat;
    if (wp.lat > maxLat) maxLat = wp.lat;
  }

  const minLonDeg = Math.floor(minLon + 180);
  const maxLonDeg = Math.floor(maxLon + 180);
  const minLatDeg = Math.floor(minLat + 90);
  const maxLatDeg = Math.floor(maxLat + 90);

  const squares: TileSquare[] = [];
  for (let lonDeg = minLonDeg; lonDeg <= maxLonDeg; lonDeg++) {
    for (let latDeg = minLatDeg; latDeg <= maxLatDeg; latDeg++) {
      const lonMod5 = lonDeg % 5;
      const latMod5 = latDeg % 5;
      const baseLon = lonDeg - 180 - lonMod5;
      const baseLat = latDeg - 90 - latMod5;
      const slon = baseLon < 0 ? `W${-baseLon}` : `E${baseLon}`;
      const slat = baseLat < 0 ? `S${-baseLat}` : `N${baseLat}`;
      const segmentName = `${slon}_${slat}`;
      squares.push({
        segmentName,
        lonDeg,
        latDeg,
        key: `${lonDeg}_${latDeg}`,
      });
    }
  }
  return squares;
}

/**
 * Ensures the specified routing profile is loaded into the WASM router.
 */
async function ensureProfileLoaded(profileName: string): Promise<void> {
  if (loadedProfiles.has(profileName)) return;

  postMessage({ type: 'STATUS', message: `Loading profile ${profileName}...` });
  const bytes = await fetchWithCache(`/profiles/${profileName}.brf`, (msg) => {
    postMessage({ type: 'STATUS', message: msg });
  });

  const text = new TextDecoder().decode(bytes);
  router!.load_profile(profileName, text);
  loadedProfiles.add(profileName);
}

/**
 * Ensures the required 1°×1° tile squares for the route are loaded into the graph.
 */
async function ensureSquaresLoaded(squares: TileSquare[]): Promise<void> {
  const missingSquares = squares.filter((s) => !loadedSquareKeys.has(s.key));
  if (missingSquares.length === 0) {
    return;
  }

  postMessage({
    type: 'STATUS',
    message: `Loading ${missingSquares.length} road tile square(s)...`,
  });

  // If new squares need to be integrated into an already resolved graph, reload the full active set
  const allNeededSquares = [...squares];
  for (const key of loadedSquareKeys) {
    const [lond, latd] = key.split('_').map(Number);
    if (!allNeededSquares.some((s) => s.lonDeg === lond && s.latDeg === latd)) {
      const lonMod5 = lond % 5;
      const latMod5 = latd % 5;
      const baseLon = lond - 180 - lonMod5;
      const baseLat = latd - 90 - latMod5;
      const slon = baseLon < 0 ? `W${-baseLon}` : `E${baseLon}`;
      const slat = baseLat < 0 ? `S${-baseLat}` : `N${baseLat}`;
      allNeededSquares.push({
        segmentName: `${slon}_${slat}`,
        lonDeg: lond,
        latDeg: latd,
        key,
      });
    }
  }

  router!.clear_graph();
  loadedSquareKeys.clear();

  for (const sq of allNeededSquares) {
    const bytes = await getSegmentBytes(sq.segmentName);
    postMessage({
      type: 'STATUS',
      message: `Decoding 1°×1° square (${sq.lonDeg - 180}°, ${sq.latDeg - 90}°)...`,
    });
    router!.add_rd5_square(bytes, sq.lonDeg, sq.latDeg);
    loadedSquareKeys.add(sq.key);
  }

  postMessage({ type: 'STATUS', message: 'Resolving road graph connections...' });
  router!.resolve_graph();

  postMessage({
    type: 'STATUS',
    message: `Graph ready: ${router!.node_count().toLocaleString()} nodes, ${router!.edge_count().toLocaleString()} edges.`,
  });
}

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;

  switch (msg.type) {
    case 'INIT': {
      try {
        postMessage({ type: 'STATUS', message: 'Initializing WebAssembly engine...' });
        await init();
        router = new WasmRouter();

        postMessage({ type: 'STATUS', message: 'Loading lookups dictionary...' });
        const lookupsBytes = await fetchWithCache('/profiles/lookups.dat', (m) => {
          postMessage({ type: 'STATUS', message: m });
        });
        const lookupsText = new TextDecoder().decode(lookupsBytes);
        router.load_lookups(lookupsText);

        // Preload default profile
        await ensureProfileLoaded('fastbike-lowtraffic');

        isInitialized = true;
        postMessage({
          type: 'STATUS',
          message: 'Router ready. Click on the map to set waypoints.',
        });
      } catch (err) {
        postMessage({
          type: 'STATUS',
          message: `Initialization failed: ${String(err)}`,
        });
      }
      break;
    }

    case 'ROUTE_REQUEST': {
      if (!isInitialized || !router) {
        postMessage({
          type: 'ROUTE_ERROR',
          id: msg.id,
          error: 'Router is not initialized yet.',
        });
        return;
      }

      try {
        const { waypoints, profile, alternativeIdx } = msg.payload;

        // Ensure the profile is loaded
        await ensureProfileLoaded(profile);

        // Calculate and load only the 1°×1° squares covering the route bounding box
        const requiredSquares = getSquaresForBoundingBox(waypoints);
        await ensureSquaresLoaded(requiredSquares);

        postMessage({
          type: 'STATUS',
          message: `Calculating route (${waypoints.length} points, ${profile})...`,
        });

        const waypointsStr = waypoints.map((w) => `${w.lon},${w.lat}`).join('|');
        const altIdx = alternativeIdx ?? 0;

        const geojsonStr = router.find_route(waypointsStr, profile, altIdx);
        const response: RouteResponse = JSON.parse(geojsonStr);

        postMessage({
          type: 'ROUTE_SUCCESS',
          id: msg.id,
          payload: response,
        });
      } catch (err) {
        postMessage({
          type: 'ROUTE_ERROR',
          id: msg.id,
          error: String(err),
        });
      }
      break;
    }

    case 'CACHE_STATUS_REQUEST': {
      const result: Record<string, { cached: boolean; sizeBytes: number }> = {};
      if ('caches' in self) {
        try {
          const cache = await self.caches.open(CACHE_NAME);
          const requests = await cache.keys();
          for (const req of requests) {
            const match = req.url.match(/([EW]\d+_[NS]\d+)\.rd5/);
            if (match) {
              const id = match[1];
              const cachedRes = await cache.match(req);
              if (cachedRes) {
                const contentType = cachedRes.headers.get('content-type') || '';
                const blob = await cachedRes.blob();
                if (contentType.includes('text/html') || blob.size < 50000) {
                  // Purge corrupted/invalid cache entry (e.g. 0 MB HTML fallback)
                  console.warn(`Purging invalid cache entry for ${id} (${blob.size} bytes)`);
                  await cache.delete(req);
                } else {
                  result[id] = { cached: true, sizeBytes: blob.size };
                }
              }
            }
          }
        } catch (err) {
          console.warn('Failed to query CacheStorage status:', err);
        }
      }
      postMessage({ type: 'CACHE_STATUS_RESPONSE', segments: result });
      break;
    }

    case 'DOWNLOAD_SEGMENT': {
      const { segmentId } = msg;
      try {
        postMessage({
          type: 'DOWNLOAD_PROGRESS',
          segmentId,
          message: `Starting download of segment ${segmentId}...`,
        });
        const bytes = await getSegmentBytes(segmentId, (progressMsg) => {
          postMessage({
            type: 'DOWNLOAD_PROGRESS',
            segmentId,
            message: progressMsg,
          });
        });
        postMessage({
          type: 'DOWNLOAD_COMPLETE',
          segmentId,
          sizeBytes: bytes.byteLength,
        });
      } catch (err) {
        const errorText = err instanceof Error ? err.message : String(err);
        postMessage({
          type: 'DOWNLOAD_ERROR',
          segmentId,
          error: errorText,
        });
      }
      break;
    }

    case 'DELETE_SEGMENT': {
      const { segmentId } = msg;
      try {
        if ('caches' in self) {
          const cache = await self.caches.open(CACHE_NAME);
          const requests = await cache.keys();
          for (const req of requests) {
            if (req.url.includes(`${segmentId}.rd5`)) {
              await cache.delete(req);
            }
          }
        }
        router?.clear_graph();
        loadedSquareKeys.clear();
        postMessage({ type: 'DELETE_COMPLETE', segmentId });
      } catch (err) {
        postMessage({
          type: 'STATUS',
          message: `Failed to delete ${segmentId}: ${String(err)}`,
        });
      }
      break;
    }

    case 'SET_OFFLINE_MODE': {
      isOfflineMode = msg.offline;
      break;
    }
  }
};
