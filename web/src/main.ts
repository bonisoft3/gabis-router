import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as pmtiles from 'pmtiles';
import * as protomapsThemesBase from 'protomaps-themes-base';
import type { WorkerMessage } from './types.ts';
import { drawRouteLayer, getCurrentRoute, initRoute, setWaypoints } from './route.ts';
import { drawCompareLayer, initCompare } from './compare.ts';

import './settings.ts';
import { getBasemap, getThunderforestKey, onBasemapChange } from './basemap.ts';
import type { DownloadEvent, DownloadRequest } from './download-worker.ts';

// Ignore benign fetch abort cancellations from rapid style changes or aborted requests
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  const isAbort =
    (reason instanceof DOMException && (reason.name === 'AbortError' || /signal is aborted/i.test(reason.message))) ||
    (reason instanceof Error && (reason.name === 'AbortError' || /signal is aborted/i.test(reason.message))) ||
    (typeof reason === 'string' && /signal is aborted/i.test(reason));
  if (isAbort) {
    event.preventDefault();
  }
});

window.addEventListener('error', (event) => {
  const msg = event.message || (event.error && event.error.message) || '';
  if (/signal is aborted/i.test(msg) || (event.error instanceof DOMException && event.error.name === 'AbortError')) {
    event.preventDefault();
  }
});

const origConsoleError = console.error;
console.error = (...args: any[]) => {
  const msg = args.map((a) => (a && (a.message || String(a))) || '').join(' ');
  if (/signal is aborted/i.test(msg) || (args[0] instanceof DOMException && args[0].name === 'AbortError')) {
    return;
  }
  origConsoleError.apply(console, args);
};

// UI Elements
const statusEl = document.getElementById('status')!;
const btnToggleCollapse = document.getElementById('btn-toggle-collapse') as HTMLButtonElement;
const controlsEl = document.getElementById('controls') as HTMLDivElement;
const checkOfflineMode = document.getElementById('check-offline-mode') as HTMLInputElement;
const badgeOfflineStatus = document.getElementById('badge-offline-status') as HTMLSpanElement;
const offlineCardBadge = document.getElementById('offline-card-badge') as HTMLSpanElement;
const offlineCardDesc = document.getElementById('offline-card-desc') as HTMLParagraphElement;
const progressBarContainer = document.getElementById('offline-progress-bar-container') as HTMLDivElement;
const progressBar = document.getElementById('offline-progress-bar') as HTMLDivElement;
const btnDownloadOffline = document.getElementById('btn-download-offline') as HTMLButtonElement;
const btnDeleteOffline = document.getElementById('btn-delete-offline') as HTMLButtonElement;

// 5°×5° segments covering the UK and Ireland. Used for both routing data (.rd5) and map tiles (.pmtiles).
const UK_SEGMENTS = [
  'W15_N50', // Ireland, far west coast
  'W10_N50', // Ireland, Northern Ireland, Cornwall west tip
  'W10_N55', // Donegal, Outer Hebrides
  'W5_N50', // England, Wales, southern Scotland
  'W5_N55', // Scotland, Orkney
  'W5_N60', // Shetland
  'E0_N50', // East England
];
const SEGMENT_CACHE_NAME = 'rsrouter-segments-v2';
const MAP_TILES_CACHE_NAME = 'rsrouter-map-tiles-v1';
const MIN_RD5_BYTES = 50000;
const FONT_BASE_URL = 'https://cdn.protomaps.com/fonts/pbf/';
const FONT_NAMES = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'];
// Basic Latin plus Latin-1 and Latin Extended-A, which covers Welsh (ŵ, ŷ) and Irish names.
const FONT_RANGES = ['0-255', '256-511'];
const ROUTING_FILES = [
  '/profiles/lookups.dat',
  '/profiles/fastbike.brf',
  '/profiles/fastbike-lowtraffic.brf',
  '/profiles/fastbike-verylowtraffic.brf',
  '/profiles/gabis-lite-gravel.brf',
  '/profiles/gabis-safe-road.brf',
  '/profiles/gravel.brf',
  '/profiles/trekking.brf',
];

// UK and Ireland focus area
const UK_CENTER: [number, number] = [-4.5, 54.5];
const UK_BOUNDS: [[number, number], [number, number]] = [
  [-15.0, 49.0], // Southwest: west of Ireland, Scilly
  [4.0, 61.5], // Northeast: Shetland, East Anglia
];

let isOfflineMode = localStorage.getItem('rsrouter_offline_mode') === 'true';

// Collapsible panel toggle
btnToggleCollapse.addEventListener('click', () => {
  controlsEl.classList.toggle('collapsed');
});

// PMTiles in-memory map for cached archives
const loadedPMTiles = new Map<string, pmtiles.PMTiles>();
(window as any).loadedPMTiles = loadedPMTiles;
(window as any).pmtiles = pmtiles;

const pmtilesProtocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile);
(window as any).pmtilesProtocol = pmtilesProtocol;

// Composite protocol to query across downloaded PMTiles archives
maplibregl.addProtocol('pmtiles-composite', async (params) => {
  const match = params.url.match(/pmtiles-composite:\/\/(\d+)\/(\d+)\/(\d+)\.pbf/);
  if (!match) {
    return { data: new Uint8Array(0) };
  }
  const z = parseInt(match[1], 10);
  const x = parseInt(match[2], 10);
  const y = parseInt(match[3], 10);

  // Tiles requested before the stored archives are open would otherwise come back empty.
  await archivesReady;

  for (const p of loadedPMTiles.values()) {
    const tile = await p.getZxy(z, x, y);
    if (tile && tile.data) {
      return { data: tile.data };
    }
  }

  return { data: new Uint8Array(0) };
});

// Font glyphs for the offline style. Served from the map tiles cache, filled by the download.
maplibregl.addProtocol('offline-tile', async (params, abortController) => {
  const originalUrl = params.url.replace(/^offline-tile:\/\//, 'https://');

  const cache = await caches.open(MAP_TILES_CACHE_NAME);
  const cached = await cache.match(originalUrl);
  if (cached) {
    return { data: await cached.arrayBuffer() };
  }

  if (isOfflineMode) {
    // Glyph range not downloaded: render those labels without text instead of failing.
    return { data: new ArrayBuffer(0) };
  }

  try {
    const res = await fetch(originalUrl, { signal: abortController.signal });
    if (!res.ok) {
      throw new Error(`Failed to fetch map resource: HTTP ${res.status}`);
    }
    await cache.put(originalUrl, res.clone());
    return { data: await res.arrayBuffer() };
  } catch (err: any) {
    if (
      abortController.signal.aborted ||
      (err instanceof DOMException && err.name === 'AbortError') ||
      /signal is aborted/i.test(err?.message || '')
    ) {
      return { data: new ArrayBuffer(0) };
    }
    throw err;
  }
});

function getOfflineStyle(): maplibregl.StyleSpecification {
  const layers = protomapsThemesBase.default('protomaps', 'light', 'en') as any[];

  // These road and land tweaks are tuned for the light theme.
  for (const l of layers) {
    if (l.id === 'landcover') {
      l.paint = l.paint || {};
      l.paint['fill-opacity'] = ['interpolate', ['linear'], ['zoom'], 5, 1, 7, 0.6, 9, 0.3, 11, 0];
    } else if (l.id === 'landuse_park') {
      l.paint = l.paint || {};
      l.paint['fill-opacity'] = ['interpolate', ['linear'], ['zoom'], 6, 0.3, 8, 0.6, 11, 1];
    } else if (l.id === 'roads_major_casing_early') {
      l.paint = l.paint || {};
      l.paint['line-color'] = '#b8b2a8';
      l.paint['line-width'] = ['interpolate', ['exponential', 1.6], ['zoom'], 6, 0.4, 8, 0.8, 10, 1.1, 12, 1.3];
      l.paint['line-gap-width'] = ['interpolate', ['exponential', 1.6], ['zoom'], 6, 0.4, 8, 0.8, 12, 1.6];
    } else if (l.id === 'roads_major_casing_late') {
      l.paint = l.paint || {};
      l.paint['line-color'] = '#b8b2a8';
    } else if (l.id === 'roads_major') {
      l.paint = l.paint || {};
      l.paint['line-width'] = ['interpolate', ['exponential', 1.6], ['zoom'], 6, 0.6, 8, 1.0, 12, 1.6, 15, 3, 18, 13];
    } else if (l.id === 'roads_highway_casing_early') {
      l.paint = l.paint || {};
      l.paint['line-color'] = '#c49a6c';
      l.paint['line-width'] = ['interpolate', ['exponential', 1.6], ['zoom'], 4, 0.5, 7, 0.9, 12, 1.4];
      l.paint['line-gap-width'] = ['interpolate', ['exponential', 1.6], ['zoom'], 3, 0.3, 6, 1.0, 12, 1.8];
    } else if (l.id === 'roads_highway_casing_late') {
      l.paint = l.paint || {};
      l.paint['line-color'] = '#c49a6c';
    } else if (l.id === 'roads_highway') {
      l.paint = l.paint || {};
      l.paint['line-color'] = '#fcd0a1';
      l.paint['line-width'] = ['interpolate', ['exponential', 1.6], ['zoom'], 3, 0.6, 6, 1.3, 8, 1.8, 12, 2.2, 15, 5, 18, 15];
    }
  }

  return {
    version: 8,
    glyphs: `${FONT_BASE_URL.replace(/^https:\/\//, 'offline-tile://')}{fontstack}/{range}.pbf`,
    sources: {
      protomaps: {
        type: 'vector',
        tiles: ['pmtiles-composite://{z}/{x}/{y}.pbf'],
        minzoom: 0,
        maxzoom: 14,
        attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
      },
    },
    layers: layers as any,
  };
}

const ONLINE_STYLE_URL = 'https://tiles.openfreemap.org/styles/bright';

const CYCLOSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    cyclosm: {
      type: 'raster',
      tiles: [
        'https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
        'https://b.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
        'https://c.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors. Tiles courtesy of <a href="https://www.cyclosm.org" target="_blank" rel="noopener">CyclOSM</a>',
    },
  },
  layers: [
    {
      id: 'cyclosm-tiles',
      type: 'raster',
      source: 'cyclosm',
      minzoom: 0,
      maxzoom: 19,
    },
  ],
};

function getOpenCycleMapStyle(): maplibregl.StyleSpecification {
  const key = getThunderforestKey();
  const query = key ? `?apikey=${encodeURIComponent(key)}` : '';
  return {
    version: 8,
    sources: {
      opencyclemap: {
        type: 'raster',
        tiles: [
          `https://a.tile.thunderforest.com/cycle/{z}/{x}/{y}.png${query}`,
          `https://b.tile.thunderforest.com/cycle/{z}/{x}/{y}.png${query}`,
          `https://c.tile.thunderforest.com/cycle/{z}/{x}/{y}.png${query}`,
        ],
        tileSize: 256,
        maxzoom: 18,
        attribution:
          'Maps © <a href="https://www.thunderforest.com/" target="_blank" rel="noopener">Thunderforest</a>, Data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>',
      },
    },
    layers: [
      {
        id: 'opencyclemap-tiles',
        type: 'raster',
        source: 'opencyclemap',
        minzoom: 0,
        maxzoom: 18,
      },
    ],
  };
}

function getOnlineStyle(): string | maplibregl.StyleSpecification {
  const b = getBasemap();
  if (b === 'cyclosm') {
    return CYCLOSM_STYLE;
  }
  if (b === 'opencyclemap') {
    return getOpenCycleMapStyle();
  }
  return ONLINE_STYLE_URL;
}

// Which style the map currently shows, and whether it has finished loading.
let appliedStyleOffline = isOfflineMode;
let appliedBasemap = getBasemap();
let appliedThunderforestKey = getThunderforestKey();
let styleReady = false;

// Initialize MapLibre GL JS centered and bounded to UK and Ireland
const map = new maplibregl.Map({
  container: 'map',
  style: isOfflineMode ? getOfflineStyle() : getOnlineStyle(),
  center: UK_CENTER,
  zoom: 6,
  maxBounds: isOfflineMode ? UK_BOUNDS : undefined,
});

function applyMapStyle(offline: boolean) {
  const currentBasemap = getBasemap();
  const currentKey = getThunderforestKey();

  if (
    offline === appliedStyleOffline &&
    currentBasemap === appliedBasemap &&
    currentKey === appliedThunderforestKey
  ) {
    return;
  }

  appliedStyleOffline = offline;
  appliedBasemap = currentBasemap;
  appliedThunderforestKey = currentKey;
  styleReady = false;
  // Offline data only covers the UK and Ireland. Online, any region can be viewed and routed.
  map.setMaxBounds(offline ? UK_BOUNDS : null);
  // diff: false forces a full reload, so 'style.load' fires and the route layer is re-added.
  map.setStyle(offline ? getOfflineStyle() : getOnlineStyle(), { diff: false });
}

onBasemapChange(() => applyMapStyle(isOfflineMode));

map.addControl(new maplibregl.NavigationControl(), 'bottom-right');
(window as any).map = map;
(window as any).maplibregl = maplibregl;

// Fires on first load and after every applyMapStyle. Re-adds the route layer.
map.on('style.load', () => {
  styleReady = true;
  drawRouteLayer();
  drawCompareLayer();
});

map.on('error', (e) => {
  // Changing the style cancels requests that are still running. That is expected.
  const err = e.error;
  const msg = (err && (err.message || String(err))) || '';
  if (err instanceof DOMException && err.name === 'AbortError') return;
  if (/signal is aborted/i.test(msg) || /aborted/i.test(msg)) return;
  if (err && typeof err === 'object' && ('status' in err || /403|401|404/i.test(msg))) {
    console.warn('[MapLibre tile request notice]', msg || err);
    return;
  }
  console.error('[MapLibre error]', err);
});

map.on('styleimagemissing', (e) => {
  const id = e.id;
  if (!map.hasImage(id)) {
    map.addImage(id, {
      width: 1,
      height: 1,
      data: new Uint8Array(4),
    });
  }
});

// Map tile archives live in the Origin Private File System (OPFS).
// A file only counts as complete once its size is recorded here after a finished download,
// so a partial file left by an interrupted download is never used.
const TILES_DONE_KEY = 'rsrouter_map_tiles_done';

function pmtilesFileName(segmentId: string): string {
  return `${segmentId}.pmtiles`;
}

function getCompletedTiles(): Record<string, number> {
  return JSON.parse(localStorage.getItem(TILES_DONE_KEY) || '{}');
}

function setTileCompleted(segmentId: string, size: number | null) {
  const done = getCompletedTiles();
  if (size === null) {
    delete done[segmentId];
  } else {
    done[segmentId] = size;
  }
  localStorage.setItem(TILES_DONE_KEY, JSON.stringify(done));
}

// Returns the stored archive only if it is complete.
async function getTileFile(segmentId: string): Promise<File | null> {
  const expectedSize = getCompletedTiles()[segmentId];
  if (!expectedSize) return null;
  const dir = await navigator.storage.getDirectory();
  try {
    const handle = await dir.getFileHandle(pmtilesFileName(segmentId));
    const file = await handle.getFile();
    return file.size === expectedSize ? file : null;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') return null;
    throw err;
  }
}

async function deleteTileFile(segmentId: string) {
  setTileCompleted(segmentId, null);
  loadedPMTiles.delete(segmentId);
  const dir = await navigator.storage.getDirectory();
  try {
    await dir.removeEntry(pmtilesFileName(segmentId));
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'NotFoundError')) throw err;
  }
}

// The File returned by OPFS is backed by disk. PMTiles reads small slices on demand,
// so the archive is never loaded into memory as a whole.
async function loadPMTilesArchive(segmentId: string, file: File) {
  const p = new pmtiles.PMTiles(new pmtiles.FileSource(file));
  await p.getHeader();
  loadedPMTiles.set(segmentId, p);
}

async function initCachedMapTiles() {
  // Archives used to be stored in IndexedDB. Drop that copy; it is re-downloaded into OPFS.
  indexedDB.deleteDatabase('rsrouter-pmtiles-v1');

  // Older versions cached every online map tile here. Only fonts belong in this cache.
  const tileCache = await caches.open(MAP_TILES_CACHE_NAME);
  for (const req of await tileCache.keys()) {
    if (!req.url.startsWith(FONT_BASE_URL)) {
      await tileCache.delete(req);
    }
  }

  for (const id of UK_SEGMENTS) {
    const file = await getTileFile(id);
    if (file) {
      await loadPMTilesArchive(id, file);
    }
  }
}

const archivesReady = initCachedMapTiles();

// Size of a cached routing segment, read from headers so the file is not loaded into memory.
async function getCachedSegmentSize(cache: Cache, segmentId: string): Promise<number> {
  const match = await cache.match(`/segments4/${segmentId}.rd5`);
  return Number(match?.headers.get('content-length')) || 0;
}

// Verification: Check if all offline components are present
async function checkOfflineBundleStatus(): Promise<{ ready: boolean; totalBytes: number }> {
  let totalBytes = 0;

  for (const id of UK_SEGMENTS) {
    const file = await getTileFile(id);
    if (!file) return { ready: false, totalBytes: 0 };
    totalBytes += file.size;
  }

  const cache = await caches.open(SEGMENT_CACHE_NAME);
  for (const id of UK_SEGMENTS) {
    const size = await getCachedSegmentSize(cache, id);
    if (size < MIN_RD5_BYTES) return { ready: false, totalBytes: 0 };
    totalBytes += size;
  }

  // The router cannot start offline without lookups and profiles.
  for (const url of ROUTING_FILES) {
    if (!(await cache.match(url))) return { ready: false, totalBytes: 0 };
  }

  return { ready: true, totalBytes };
}

// UI State Updater
async function updateOfflineUI(bundleStatus?: { ready: boolean; totalBytes: number }) {
  const status = bundleStatus || (await checkOfflineBundleStatus());

  if (status.ready) {
    checkOfflineMode.disabled = false;
    offlineCardBadge.textContent = 'Ready';
    offlineCardBadge.className = 'offline-mini-badge badge-ready';
    const mb = Math.round(status.totalBytes / (1024 * 1024));
    offlineCardDesc.textContent = `UK and Ireland offline data ready: ${mb} MB.`;
    btnDownloadOffline.style.display = 'none';
    btnDeleteOffline.style.display = 'inline-flex';
    progressBarContainer.style.display = 'none';
  } else {
    if (isOfflineMode) {
      setOfflineMode(false);
    }
    checkOfflineMode.disabled = true;
    checkOfflineMode.checked = false;
    offlineCardBadge.textContent = 'Not Downloaded';
    offlineCardBadge.className = 'offline-mini-badge badge-missing';
    offlineCardDesc.textContent = 'Download UK routing data and map tiles to enable offline mode.';
    btnDownloadOffline.style.display = 'inline-flex';
    btnDownloadOffline.disabled = false;
    btnDownloadOffline.textContent = 'Download UK Data';
    btnDeleteOffline.style.display = 'none';
    progressBarContainer.style.display = 'none';
  }
}

// Offline Mode Controller
function setOfflineMode(enabled: boolean) {
  const changed = enabled !== appliedStyleOffline;
  isOfflineMode = enabled;
  localStorage.setItem('rsrouter_offline_mode', String(enabled));
  checkOfflineMode.checked = enabled;
  const basemapSelectEl = document.getElementById('select-basemap') as HTMLSelectElement | null;
  if (basemapSelectEl) basemapSelectEl.disabled = enabled;
  badgeOfflineStatus.textContent = enabled ? 'Offline' : 'Online';
  badgeOfflineStatus.className = `offline-badge ${enabled ? 'badge-offline' : 'badge-online'}`;
  worker.postMessage({ type: 'SET_OFFLINE_MODE', offline: enabled } satisfies WorkerMessage);

  if (changed) {
    applyMapStyle(enabled);
    statusEl.textContent = enabled
      ? 'Offline mode active. Rendering with local PMTiles archives.'
      : 'Online mode active. Streaming tiles on the fly.';
  }
}

// Mandatory Offline Mode Guard: Prevent toggling offline mode if data is not downloaded
checkOfflineMode.addEventListener('change', async () => {
  const status = await checkOfflineBundleStatus();
  if (!status.ready && checkOfflineMode.checked) {
    checkOfflineMode.checked = false;
    statusEl.textContent = 'Download UK offline data before enabling offline mode.';
    return;
  }
  setOfflineMode(checkOfflineMode.checked);
});

// Web Worker for off-thread routing
const worker = new Worker(new URL('./worker.ts', import.meta.url), {
  type: 'module',
});

worker.postMessage({ type: 'SET_OFFLINE_MODE', offline: isOfflineMode } satisfies WorkerMessage);
worker.postMessage({ type: 'INIT' } satisfies WorkerMessage);

initRoute({ map, worker, isStyleReady: () => styleReady });
initCompare({ map, isStyleReady: () => styleReady, setWaypoints });
(window as any).getCurrentRoute = getCurrentRoute;

// Offline Bundle Download Helpers
async function cacheMapFonts(onProgress: (msg: string) => void) {
  const cache = await caches.open(MAP_TILES_CACHE_NAME);
  for (const fontName of FONT_NAMES) {
    onProgress(`Downloading font ${fontName}...`);
    for (const range of FONT_RANGES) {
      const url = `${FONT_BASE_URL}${encodeURIComponent(fontName)}/${range}.pbf`;
      if (await cache.match(url)) continue;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to download font ${fontName} ${range}: HTTP ${res.status}`);
      }
      await cache.put(url, res);
    }
  }
}

async function cacheRoutingProfiles(onProgress: (msg: string) => void) {
  const cache = await caches.open(SEGMENT_CACHE_NAME);
  for (const url of ROUTING_FILES) {
    if (await cache.match(url)) continue;
    onProgress(`Downloading profile ${url.split('/').pop()}...`);
    const res = await fetch(url);
    if (!res.ok || (res.headers.get('content-type') || '').includes('text/html')) {
      throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
    }
    await cache.put(url, res);
  }
}

// Fails early with a clear message if the browser cannot store another `bytes` bytes.
async function ensureStorageFor(bytes: number, what: string) {
  const { quota = 0, usage = 0 } = await navigator.storage.estimate();
  const free = quota - usage;
  if (bytes > free) {
    const needMb = Math.round(bytes / (1024 * 1024));
    const freeMb = Math.round(free / (1024 * 1024));
    throw new Error(`Not enough browser storage for ${what}: needs ${needMb} MB, ${freeMb} MB free`);
  }
}

// Streams a routing segment into CacheStorage without holding the whole file in memory.
async function cacheSegmentRd5(
  segmentId: string,
  onProgress: (received: number, total: number) => void,
) {
  const cache = await caches.open(SEGMENT_CACHE_NAME);
  const localUrl = `/segments4/${segmentId}.rd5`;
  if ((await getCachedSegmentSize(cache, segmentId)) >= MIN_RD5_BYTES) {
    return;
  }

  // Bundled locally for some segments, otherwise proxied from brouter.de.
  // Static hosts answer missing files with index.html and HTTP 200, so treat HTML as missing.
  const isHtml = (r: Response) => (r.headers.get('content-type') || '').includes('text/html');
  let res = await fetch(localUrl);
  if (!res.ok || isHtml(res)) {
    res = await fetch(`/remote-segments/${segmentId}.rd5`);
  }
  if (!res.ok || !res.body || isHtml(res)) {
    throw new Error(`Failed to fetch routing segment ${segmentId}: HTTP ${res.status}`);
  }
  // Servers that compress on the fly send no content-length. Then the size is only known at the end.
  const total = Number(res.headers.get('content-length')) || 0;
  if (total) {
    if (total < MIN_RD5_BYTES) {
      throw new Error(`Routing segment ${segmentId} is too small (${total} bytes)`);
    }
    await ensureStorageFor(total, `${segmentId}.rd5`);
  }

  let received = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      onProgress(received, total);
      controller.enqueue(chunk);
    },
    flush() {
      if (total ? received !== total : received < MIN_RD5_BYTES) {
        throw new Error(`Incomplete download of ${segmentId}.rd5: ${received} of ${total || '?'} bytes`);
      }
    },
  });

  const headers = { 'content-type': 'application/octet-stream' };
  await cache.put(
    localUrl,
    new Response(res.body.pipeThrough(counter), {
      headers: total ? { ...headers, 'content-length': String(total) } : headers,
    }),
  );

  if (!total) {
    // getCachedSegmentSize reads the size from this header. Copy the entry once, disk to disk, to set it.
    const stored = await cache.match(localUrl);
    if (!stored?.body) throw new Error(`Routing segment ${segmentId} was not stored`);
    await cache.put(
      localUrl,
      new Response(stored.body, { headers: { ...headers, 'content-length': String(received) } }),
    );
  }
}

// Streams a map tile archive to OPFS in a worker, then opens it from disk.
async function downloadMapTilesForSegment(
  segmentId: string,
  onProgress: (received: number, total: number) => void,
) {
  if (loadedPMTiles.has(segmentId)) return;
  const existing = await getTileFile(segmentId);
  if (existing) {
    await loadPMTilesArchive(segmentId, existing);
    return;
  }

  setTileCompleted(segmentId, null);
  const dl = new Worker(new URL('./download-worker.ts', import.meta.url), { type: 'module' });
  try {
    const size = await new Promise<number>((resolve, reject) => {
      dl.onmessage = (e: MessageEvent<DownloadEvent>) => {
        const msg = e.data;
        if (msg.type === 'progress') onProgress(msg.received, msg.total);
        else if (msg.type === 'done') resolve(msg.size);
        else reject(new Error(msg.error));
      };
      dl.onerror = (e) => reject(new Error(e.message));
      dl.postMessage({
        url: `/map-tiles/${segmentId}.pmtiles`,
        fileName: pmtilesFileName(segmentId),
      } satisfies DownloadRequest);
    });
    setTileCompleted(segmentId, size);
  } finally {
    dl.terminate();
  }

  const file = await getTileFile(segmentId);
  if (!file) {
    throw new Error(`Map tiles for ${segmentId} were not saved correctly`);
  }
  await loadPMTilesArchive(segmentId, file);
}

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

// Single-Button Download: Downloads routing data, profiles, and map tiles
async function downloadUkOfflineBundle() {
  btnDownloadOffline.disabled = true;
  btnDownloadOffline.textContent = 'Downloading...';
  progressBarContainer.style.display = 'block';
  progressBar.style.width = '2%';

  try {
    // Ask the browser not to evict this data under storage pressure.
    await navigator.storage.persist();

    statusEl.textContent = 'Downloading map fonts...';
    await cacheMapFonts((msg) => {
      statusEl.textContent = msg;
    });
    progressBar.style.width = '5%';

    statusEl.textContent = 'Downloading routing profiles...';
    await cacheRoutingProfiles((msg) => {
      statusEl.textContent = msg;
    });
    progressBar.style.width = '10%';

    // Routing data is about 10% of the total size, map tiles the rest.
    const n = UK_SEGMENTS.length;
    for (let i = 0; i < n; i++) {
      const segId = UK_SEGMENTS[i];
      await cacheSegmentRd5(segId, (done, total) => {
        const frac = total > 0 ? done / total : 0;
        progressBar.style.width = `${Math.round(10 + ((i + frac) / n) * 10)}%`;
        const totalLabel = total > 0 ? formatMb(total) : '?';
        statusEl.textContent = `Routing data ${i + 1}/${n}: ${segId} (${formatMb(done)} / ${totalLabel} MB)`;
      });
    }

    for (let i = 0; i < n; i++) {
      const segId = UK_SEGMENTS[i];
      statusEl.textContent = `Map tiles ${i + 1}/${n}: ${segId} (preparing, this can take a few minutes)`;
      await downloadMapTilesForSegment(segId, (done, total) => {
        const frac = total > 0 ? done / total : 0;
        progressBar.style.width = `${Math.min(99, Math.round(20 + ((i + frac) / n) * 80))}%`;
        const totalLabel = total > 0 ? formatMb(total) : '?';
        statusEl.textContent = `Map tiles ${i + 1}/${n}: ${segId} (${formatMb(done)} / ${totalLabel} MB)`;
      });
    }

    progressBar.style.width = '100%';
    await updateOfflineUI(await checkOfflineBundleStatus());
    statusEl.textContent = 'Offline data downloaded. You can now enable Offline Mode.';
  } catch (err) {
    console.error('Offline download failed:', err);
    await updateOfflineUI(await checkOfflineBundleStatus());
    statusEl.textContent = `Download failed: ${err instanceof Error ? err.message : String(err)}. Press Download to resume.`;
  }
}

async function deleteUkOfflineBundle() {
  if (isOfflineMode) {
    setOfflineMode(false);
  }
  statusEl.textContent = 'Removing offline data...';

  for (const segId of UK_SEGMENTS) {
    await deleteTileFile(segId);
  }

  const cache = await caches.open(SEGMENT_CACHE_NAME);
  for (const segId of UK_SEGMENTS) {
    await cache.delete(`/segments4/${segId}.rd5`);
    await cache.delete(`/remote-segments/${segId}.rd5`);
  }
  worker.postMessage({ type: 'CLEAR_GRAPH' } satisfies WorkerMessage);

  await updateOfflineUI(await checkOfflineBundleStatus());
  statusEl.textContent = 'Offline data removed from local storage.';
}

btnDownloadOffline.addEventListener('click', downloadUkOfflineBundle);
btnDeleteOffline.addEventListener('click', deleteUkOfflineBundle);

// Initialization: wait for stored archives, check offline bundle status, enforce rules
archivesReady.then(async () => {
  const status = await checkOfflineBundleStatus();
  if (isOfflineMode && !status.ready) {
    isOfflineMode = false;
  }
  if (!navigator.onLine && status.ready) {
    isOfflineMode = true;
  }
  setOfflineMode(isOfflineMode);
  await updateOfflineUI(status);
});

// Losing the network mid-session: switch to the downloaded data if there is any.
window.addEventListener('offline', async () => {
  if (isOfflineMode) return;
  const status = await checkOfflineBundleStatus();
  if (status.ready) {
    setOfflineMode(true);
  }
});

// Service worker registration
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}
