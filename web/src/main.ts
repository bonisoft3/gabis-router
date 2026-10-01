import maplibregl from 'maplibre-gl';
import * as pmtiles from 'pmtiles';
import * as protomapsThemesBase from 'protomaps-themes-base';
import type { LatLon, ProfileName, SegmentInfo, WorkerMessage } from './types.ts';

// UI Elements
const statusEl = document.getElementById('status')!;
const profileSelect = document.getElementById('profile-select') as HTMLSelectElement;
const btnClearRoute = document.getElementById('btn-clear-route') as HTMLButtonElement;
const tabBtnRoute = document.getElementById('tab-btn-route') as HTMLButtonElement;
const tabBtnTiles = document.getElementById('tab-btn-tiles') as HTMLButtonElement;
const panelRoute = document.getElementById('panel-route') as HTMLDivElement;
const panelTiles = document.getElementById('panel-tiles') as HTMLDivElement;
const storageSummaryEl = document.getElementById('storage-summary') as HTMLDivElement;
const segmentListEl = document.getElementById('segment-list') as HTMLDivElement;
const btnToggleCollapse = document.getElementById('btn-toggle-collapse') as HTMLButtonElement;
const controlsEl = document.getElementById('controls') as HTMLDivElement;
const checkSelectAll = document.getElementById('check-select-all') as HTMLInputElement | null;
const selectedSummaryEl = document.getElementById('selected-summary') as HTMLSpanElement | null;
const btnBulkDownload = document.getElementById('btn-bulk-download') as HTMLButtonElement | null;
const btnBulkDelete = document.getElementById('btn-bulk-delete') as HTMLButtonElement | null;
const checkOfflineMode = document.getElementById('check-offline-mode') as HTMLInputElement | null;
const badgeOfflineStatus = document.getElementById('badge-offline-status') as HTMLSpanElement | null;
const mapStorageSummaryEl = document.getElementById('map-storage-summary') as HTMLDivElement | null;

const MAP_TILES_CACHE_NAME = 'rsrouter-map-tiles-v1';
let isOfflineMode = localStorage.getItem('rsrouter_offline_mode') === 'true';

let currentTab: 'route' | 'tiles' = 'route';
const cachedSegments = new Map<string, { sizeBytes: number }>();
const downloadingSegments = new Set<string>();
const selectedSegmentIds = new Set<string>();
const downloadQueue: string[] = [];
let isProcessingQueue = false;

// Collapsible panel toggle
btnToggleCollapse.addEventListener('click', () => {
  controlsEl.classList.toggle('collapsed');
});

// Dynamic 5°×5° Grid Helpers
function parseSegmentId(id: string): { bbox: [number, number, number, number]; minLon: number; minLat: number } {
  const match = id.match(/^([EW])(\d+)_([NS])(\d+)$/);
  if (!match) {
    return { bbox: [0, 0, 5, 5], minLon: 0, minLat: 0 };
  }
  const lonDir = match[1];
  const lonVal = parseInt(match[2], 10);
  const latDir = match[3];
  const latVal = parseInt(match[4], 10);
  const minLon = lonDir === 'W' ? -lonVal : lonVal;
  const minLat = latDir === 'S' ? -latVal : latVal;
  return {
    bbox: [minLon, minLat, minLon + 5, minLat + 5],
    minLon,
    minLat,
  };
}

function formatCoord(val: number, isLat: boolean): string {
  if (isLat) {
    return val >= 0 ? `${val}°N` : `${Math.abs(val)}°S`;
  }
  return val >= 0 ? `${val}°E` : `${Math.abs(val)}°W`;
}

function formatBounds(bbox: [number, number, number, number]): string {
  const [w, s, e, n] = bbox;
  return `${formatCoord(s, true)} to ${formatCoord(n, true)}, ${formatCoord(w, false)} to ${formatCoord(e, false)}`;
}

function getSegmentIdFromCoords(lon: number, lat: number): string {
  const clampedLat = Math.max(-85, Math.min(85, lat));
  let normLon = lon;
  while (normLon < -180) normLon += 360;
  while (normLon >= 180) normLon -= 360;

  const minLon = Math.floor(normLon / 5) * 5;
  const minLat = Math.floor(clampedLat / 5) * 5;

  const lonStr = minLon < 0 ? `W${Math.abs(minLon)}` : `E${minLon}`;
  const latStr = minLat < 0 ? `S${Math.abs(minLat)}` : `N${minLat}`;
  return `${lonStr}_${latStr}`;
}

function getVisibleSegmentIds(): string[] {
  if (!map) return [];
  const bounds = map.getBounds();
  const west = Math.max(-180, bounds.getWest());
  const east = Math.min(180, bounds.getEast());
  const south = Math.max(-85, bounds.getSouth());
  const north = Math.min(85, bounds.getNorth());

  const minLon = Math.floor(west / 5) * 5;
  const maxLon = Math.floor(east / 5) * 5;
  const minLat = Math.floor(south / 5) * 5;
  const maxLat = Math.floor(north / 5) * 5;

  const ids: string[] = [];
  for (let lat = minLat; lat <= maxLat; lat += 5) {
    for (let lon = minLon; lon <= maxLon; lon += 5) {
      const lonStr = lon < 0 ? `W${Math.abs(lon)}` : `E${lon}`;
      const latStr = lat < 0 ? `S${Math.abs(lat)}` : `N${lat}`;
      ids.push(`${lonStr}_${latStr}`);
    }
  }
  return ids;
}

function getListSegments(): { segments: SegmentInfo[]; overflowCount: number } {
  const visibleIds = getVisibleSegmentIds();
  const ids = new Set<string>();

  // Always include cached and selected segments in the list
  for (const id of cachedSegments.keys()) {
    ids.add(id);
  }
  for (const id of selectedSegmentIds) {
    ids.add(id);
  }

  let overflowCount = 0;
  if (visibleIds.length <= 60) {
    for (const id of visibleIds) {
      ids.add(id);
    }
  } else {
    overflowCount = visibleIds.length;
  }

  const list: SegmentInfo[] = [];
  for (const id of ids) {
    const { bbox } = parseSegmentId(id);
    const cachedInfo = cachedSegments.get(id);
    const isCached = !!cachedInfo;
    const isDownloading = downloadingSegments.has(id);

    list.push({
      id,
      name: formatBounds(bbox),
      bbox,
      sizeMb: cachedInfo ? Math.round(cachedInfo.sizeBytes / (1024 * 1024)) : 0,
      status: isCached ? 'cached' : isDownloading ? 'downloading' : 'available',
      cachedBytes: cachedInfo?.sizeBytes,
    });
  }

  list.sort((a, b) => {
    if (a.status === 'cached' && b.status !== 'cached') return -1;
    if (a.status !== 'cached' && b.status === 'cached') return 1;
    return a.id.localeCompare(b.id);
  });

  return { segments: list, overflowCount };
}

// PMTiles in-memory map for cached archives
const loadedPMTiles = new Map<string, pmtiles.PMTiles>();
(window as any).loadedPMTiles = loadedPMTiles;
(window as any).pmtiles = pmtiles;

const pmtilesProtocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile);
(window as any).pmtilesProtocol = pmtilesProtocol;

// Composite protocol to query across any downloaded PMTiles archives
maplibregl.addProtocol('pmtiles-composite', async (params) => {
  const match = params.url.match(/pmtiles-composite:\/\/(\d+)\/(\d+)\/(\d+)\.pbf/);
  if (!match) {
    return { data: new Uint8Array(0) };
  }
  const z = parseInt(match[1], 10);
  const x = parseInt(match[2], 10);
  const y = parseInt(match[3], 10);

  for (const [, p] of loadedPMTiles.entries()) {
    try {
      const tile = await p.getZxy(z, x, y);
      if (tile && tile.data) {
        return { data: tile.data };
      }
    } catch (_e) {
      // ignore
    }
  }

  return { data: new Uint8Array(0) };
});

// Register custom offline-tile protocol for fonts, sprites, styles
maplibregl.addProtocol('offline-tile', async (params, abortController) => {
  const originalUrl = params.url.replace(/^offline-tile:\/\//, 'https://');

  if ('caches' in window) {
    try {
      const cache = await caches.open(MAP_TILES_CACHE_NAME);
      const cached = await cache.match(originalUrl);
      if (cached) {
        if (params.type === 'json') {
          return { data: await cached.json() };
        } else if (params.type === 'arrayBuffer' || params.type === 'image') {
          return { data: await cached.arrayBuffer() };
        } else {
          return { data: await cached.text() };
        }
      }
    } catch (err) {
      console.warn('Map tile cache match error:', err);
    }
  }

  if (isOfflineMode) {
    if (params.type === 'arrayBuffer') {
      return { data: new ArrayBuffer(0) };
    }
    throw new Error(`Offline mode active: resource not cached (${originalUrl})`);
  }

  const res = await fetch(originalUrl, { signal: abortController.signal });
  if (!res.ok) {
    throw new Error(`Failed to fetch map resource: HTTP ${res.status}`);
  }

  if ('caches' in window) {
    try {
      const cache = await caches.open(MAP_TILES_CACHE_NAME);
      await cache.put(originalUrl, res.clone());
    } catch (err) {
      console.warn('Failed to cache map tile:', err);
    }
  }

  if (params.type === 'json') {
    return { data: await res.json() };
  } else if (params.type === 'arrayBuffer' || params.type === 'image') {
    return { data: await res.arrayBuffer() };
  } else {
    return { data: await res.text() };
  }
});

function getOfflineStyle(): maplibregl.StyleSpecification {
  const layers = protomapsThemesBase.default('protomaps', 'light', 'en') as any[];

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
    glyphs: 'offline-tile://cdn.protomaps.com/fonts/pbf/{fontstack}/{range}.pbf',
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

// Initialize MapLibre GL JS
const map = new maplibregl.Map({
  container: 'map',
  style: isOfflineMode
    ? getOfflineStyle()
    : 'offline-tile://tiles.openfreemap.org/styles/bright',
  center: [-1.5, 53.5], // Center of UK
  zoom: 6,
  transformRequest: (url) => {
    if (
      url.startsWith('https://tiles.openfreemap.org') ||
      url.startsWith('https://cdn.protomaps.com')
    ) {
      return { url: url.replace(/^https:\/\//, 'offline-tile://') };
    }
    return { url };
  },
});

map.addControl(new maplibregl.NavigationControl(), 'bottom-right');
(window as any).map = map;
(window as any).maplibregl = maplibregl;

map.on('error', (e) => {
  // Silence offline cache miss errors when in offline mode
  if (isOfflineMode && e.error && String(e.error).includes('Offline mode active')) {
    return;
  }
  console.error('[MapLibre error]', e);
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

// Web Worker for off-thread routing
const worker = new Worker(new URL('./worker.ts', import.meta.url), {
  type: 'module',
});

worker.postMessage({ type: 'INIT', payload: { segmentUrls: [] } });
worker.postMessage({ type: 'SET_OFFLINE_MODE', offline: isOfflineMode });

// Message handling from Web Worker
worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'STATUS':
      statusEl.textContent = msg.message;
      break;

    case 'ROUTE_SUCCESS': {
      const feat = msg.payload.features[0];
      const props = feat?.properties;
      if (props && props['track-length'] && Number(props['track-length']) > 0) {
        const distKm = (Number(props['track-length']) / 1000).toFixed(2);
        const timeMin = Math.round(Number(props['total-time']) / 60);
        const ascend = Math.round(Number(props['filtered ascend']));
        statusEl.textContent = `Distance: ${distKm} km | Time: ${timeMin} min | Ascend: ${ascend} m`;
      } else {
        statusEl.textContent = 'Route calculated successfully.';
      }
      renderRoute(msg.payload);
      break;
    }

    case 'ROUTE_ERROR':
      statusEl.textContent = `Routing error: ${msg.error}`;
      break;

    case 'CACHE_STATUS_RESPONSE': {
      cachedSegments.clear();
      for (const [id, info] of Object.entries(msg.segments)) {
        if (info.cached) {
          cachedSegments.set(id, { sizeBytes: info.sizeBytes });
        }
      }
      updateGridSource();
      renderSegmentList();
      break;
    }

    case 'DOWNLOAD_PROGRESS': {
      downloadingSegments.add(msg.segmentId);
      updateGridSource();
      renderSegmentList();
      statusEl.textContent = msg.message;
      break;
    }

    case 'DOWNLOAD_COMPLETE': {
      downloadingSegments.delete(msg.segmentId);
      cachedSegments.set(msg.segmentId, { sizeBytes: msg.sizeBytes });
      updateGridSource();
      renderSegmentList();
      statusEl.textContent = `Segment ${msg.segmentId} downloaded and cached for offline use.`;
      processDownloadQueue();
      break;
    }

    case 'DOWNLOAD_ERROR': {
      downloadingSegments.delete(msg.segmentId);
      updateGridSource();
      renderSegmentList();
      statusEl.textContent = `Download failed for ${msg.segmentId}: ${msg.error}`;
      processDownloadQueue();
      break;
    }

    case 'DELETE_COMPLETE': {
      cachedSegments.delete(msg.segmentId);
      updateGridSource();
      renderSegmentList();
      statusEl.textContent = `Segment ${msg.segmentId} removed from local cache.`;
      break;
    }
  }
};

// Routing state
let waypoints: LatLon[] = [];
let markers: maplibregl.Marker[] = [];

// Waypoint interaction and popup display on map click
map.on('click', (e) => {
  if (currentTab === 'tiles') {
    const segId = getSegmentIdFromCoords(e.lngLat.lng, e.lngLat.lat);
    toggleSegmentSelection(segId, true);
    return;
  }

  // Route mode: set waypoints
  if (waypoints.length >= 2) {
    clearWaypoints();
    clearRoute();
  }

  const point: LatLon = { lat: e.lngLat.lat, lon: e.lngLat.lng };
  waypoints.push(point);

  const markerColor = waypoints.length === 1 ? '#10b981' : '#ef4444';
  const marker = new maplibregl.Marker({ color: markerColor })
    .setLngLat([point.lon, point.lat])
    .addTo(map);
  markers.push(marker);

  if (waypoints.length === 1) {
    statusEl.textContent = 'Start point set. Click to set destination.';
  } else if (waypoints.length === 2) {
    requestRoute();
  }
});

// Cursor styling when hovering over segments in Tiles tab
map.on('mousemove', 'segments-fill', () => {
  if (currentTab === 'tiles') {
    map.getCanvas().style.cursor = 'pointer';
  }
});

map.on('mouseleave', 'segments-fill', () => {
  map.getCanvas().style.cursor = '';
});

// Refresh dynamic grid when map pans or zooms in Tiles tab
map.on('moveend', () => {
  if (currentTab === 'tiles') {
    updateGridSource();
    renderSegmentList();
  }
});

function toggleSegmentSelection(segId: string, scrollList = false) {
  if (selectedSegmentIds.has(segId)) {
    selectedSegmentIds.delete(segId);
  } else {
    selectedSegmentIds.add(segId);
  }
  updateGridSource();
  renderSegmentList();

  if (scrollList) {
    const rowEl = segmentListEl.querySelector(`[data-id="${segId}"]`) as HTMLElement | null;
    if (rowEl) {
      rowEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
}

function clearWaypoints() {
  markers.forEach((m) => m.remove());
  markers = [];
  waypoints = [];
}

btnClearRoute.addEventListener('click', () => {
  clearWaypoints();
  clearRoute();
  statusEl.textContent = 'Route cleared. Click on the map to set waypoints.';
});

profileSelect.addEventListener('change', () => {
  if (waypoints.length === 2) {
    requestRoute();
  }
});

function requestRoute() {
  const profile = profileSelect.value as ProfileName;
  statusEl.textContent = 'Requesting route...';
  worker.postMessage({
    type: 'ROUTE_REQUEST',
    id: String(Date.now()),
    payload: {
      waypoints,
      profile,
    },
  });
}

let currentRouteGeoJson: GeoJSON.FeatureCollection | null = null;
(window as any).getCurrentRoute = () => currentRouteGeoJson;

function renderRoute(geojson: GeoJSON.FeatureCollection) {
  currentRouteGeoJson = geojson;
  const source = map.getSource('route') as maplibregl.GeoJSONSource | undefined;
  if (source) {
    source.setData(geojson);
  } else {
    map.addSource('route', {
      type: 'geojson',
      data: geojson,
    });
    map.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      layout: {
        'line-join': 'round',
        'line-cap': 'round',
      },
      paint: {
        'line-color': '#2563eb',
        'line-width': 5,
        'line-opacity': 0.85,
      },
    });
  }
}

function clearRoute() {
  currentRouteGeoJson = null;
  const source = map.getSource('route') as maplibregl.GeoJSONSource | undefined;
  if (source) {
    source.setData({
      type: 'FeatureCollection',
      features: [],
    });
  }
}

// Map Grid Layer GeoJSON: covers the entire global 5°×5° grid so it never disappears
function buildGridGeoJson(): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];

  for (let lat = -85; lat < 85; lat += 5) {
    for (let lon = -180; lon < 180; lon += 5) {
      const slon = lon < 0 ? `W${Math.abs(lon)}` : `E${lon}`;
      const slat = lat < 0 ? `S${Math.abs(lat)}` : `N${lat}`;
      const id = `${slon}_${slat}`;

      const isCached = cachedSegments.has(id);
      const isDownloading = downloadingSegments.has(id);
      const isSelected = selectedSegmentIds.has(id);
      const cachedInfo = cachedSegments.get(id);

      features.push({
        type: 'Feature',
        id,
        properties: {
          id,
          name: formatBounds([lon, lat, lon + 5, lat + 5]),
          status: isCached ? 'cached' : isDownloading ? 'downloading' : 'available',
          sizeMb: cachedInfo ? Math.round(cachedInfo.sizeBytes / (1024 * 1024)) : 0,
          selected: isSelected,
        },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [lon, lat],
              [lon + 5, lat],
              [lon + 5, lat + 5],
              [lon, lat + 5],
              [lon, lat],
            ],
          ],
        },
      });
    }
  }

  return {
    type: 'FeatureCollection',
    features,
  };
}

function initGridLayers() {
  if (map.getSource('segments-grid')) {
    setGridVisibility(currentTab === 'tiles');
    return;
  }

  const initialVis = currentTab === 'tiles' ? 'visible' : 'none';

  // Add segment grid source
  map.addSource('segments-grid', {
    type: 'geojson',
    data: buildGridGeoJson(),
  });

  // Fill styling: highlighted when selected, tinted otherwise
  map.addLayer({
    id: 'segments-fill',
    type: 'fill',
    source: 'segments-grid',
    layout: {
      visibility: initialVis,
    },
    paint: {
      'fill-color': [
        'case',
        ['boolean', ['get', 'selected'], false],
        [
          'match',
          ['get', 'status'],
          'cached',
          'rgba(16, 185, 129, 0.55)',
          'downloading',
          'rgba(245, 158, 11, 0.60)',
          /* available */ 'rgba(37, 99, 235, 0.45)',
        ],
        [
          'match',
          ['get', 'status'],
          'cached',
          'rgba(16, 185, 129, 0.22)',
          'downloading',
          'rgba(245, 158, 11, 0.30)',
          /* available */ 'rgba(59, 130, 246, 0.12)',
        ],
      ],
    },
  });

  // Outer border outline: bold when selected, subtle otherwise
  map.addLayer({
    id: 'segments-line',
    type: 'line',
    source: 'segments-grid',
    layout: {
      visibility: initialVis,
    },
    paint: {
      'line-color': [
        'case',
        ['boolean', ['get', 'selected'], false],
        [
          'match',
          ['get', 'status'],
          'cached',
          '#047857',
          'downloading',
          '#b45309',
          /* available */ '#1e40af',
        ],
        [
          'match',
          ['get', 'status'],
          'cached',
          '#059669',
          'downloading',
          '#d97706',
          /* available */ '#60a5fa',
        ],
      ],
      'line-width': [
        'interpolate',
        ['linear'],
        ['zoom'],
        2,
        ['case', ['boolean', ['get', 'selected'], false], 3, 0.75],
        6,
        ['case', ['boolean', ['get', 'selected'], false], 4, 1.5],
        10,
        ['case', ['boolean', ['get', 'selected'], false], 5, 2.5],
      ],
      'line-opacity': 0.95,
    },
  });

  // Query cache status on init
  worker.postMessage({ type: 'CACHE_STATUS_REQUEST' });
}

function setGridVisibility(visible: boolean) {
  const vis = visible ? 'visible' : 'none';
  const layerIds = ['segments-fill', 'segments-line'];
  for (const id of layerIds) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', vis);
    }
  }
}

function onStyleLoaded() {
  initGridLayers();
  if (currentRouteGeoJson) {
    renderRoute(currentRouteGeoJson);
  }
}

if (map.isStyleLoaded()) {
  onStyleLoaded();
}
map.on('style.load', onStyleLoaded);
map.on('load', onStyleLoaded);

function updateGridSource() {
  const src = map.getSource('segments-grid') as maplibregl.GeoJSONSource | undefined;
  if (src) {
    src.setData(buildGridGeoJson());
  }
}

// Tab navigation
tabBtnRoute.addEventListener('click', () => switchTab('route'));
tabBtnTiles.addEventListener('click', () => switchTab('tiles'));

function switchTab(tab: 'route' | 'tiles') {
  currentTab = tab;
  if (tab === 'route') {
    tabBtnRoute.classList.add('active');
    tabBtnTiles.classList.remove('active');
    panelRoute.classList.add('active');
    panelTiles.classList.remove('active');
    setGridVisibility(false);
  } else {
    tabBtnTiles.classList.add('active');
    tabBtnRoute.classList.remove('active');
    panelTiles.classList.add('active');
    panelRoute.classList.remove('active');
    setGridVisibility(true);
    updateGridSource();
    renderSegmentList();
    worker.postMessage({ type: 'CACHE_STATUS_REQUEST' });
  }
}

function updateBulkToolbar() {
  const { segments } = getListSegments();
  const selectedCount = selectedSegmentIds.size;

  const selectedList: SegmentInfo[] = [];
  for (const id of selectedSegmentIds) {
    const { bbox } = parseSegmentId(id);
    const cachedInfo = cachedSegments.get(id);
    selectedList.push({
      id,
      name: formatBounds(bbox),
      bbox,
      sizeMb: cachedInfo ? Math.round(cachedInfo.sizeBytes / (1024 * 1024)) : 0,
      status: cachedInfo ? 'cached' : downloadingSegments.has(id) ? 'downloading' : 'available',
    });
  }

  if (selectedSummaryEl) {
    selectedSummaryEl.textContent = `${selectedCount} selected`;
  }

  if (checkSelectAll) {
    const totalCount = segments.length;
    checkSelectAll.checked = totalCount > 0 && selectedCount === totalCount;
    checkSelectAll.indeterminate = selectedCount > 0 && selectedCount < totalCount;
  }

  const unCachedCount = selectedList.filter((s) => s.status === 'available').length;
  const cachedCount = selectedList.filter((s) => s.status === 'cached').length;

  if (btnBulkDownload) {
    btnBulkDownload.disabled = selectedCount === 0;
    if (unCachedCount > 0) {
      btnBulkDownload.textContent = `Download (${selectedCount})`;
    } else {
      btnBulkDownload.textContent = `Download Map Tiles (${selectedCount})`;
    }
  }

  if (btnBulkDelete) {
    btnBulkDelete.disabled = cachedCount === 0;
    btnBulkDelete.textContent = cachedCount > 0 ? `Delete (${cachedCount})` : 'Delete Selected';
  }
}

checkSelectAll?.addEventListener('change', () => {
  const isChecked = checkSelectAll.checked;
  const { segments } = getListSegments();
  if (isChecked) {
    for (const seg of segments) {
      selectedSegmentIds.add(seg.id);
    }
  } else {
    selectedSegmentIds.clear();
  }
  updateGridSource();
  renderSegmentList();
});

btnBulkDownload?.addEventListener('click', async () => {
  if (selectedSegmentIds.size === 0) return;

  const selectedList = Array.from(selectedSegmentIds);
  const toDownloadSegments = selectedList.filter(
    (id) => !cachedSegments.has(id) && !downloadingSegments.has(id),
  );

  for (const id of toDownloadSegments) {
    if (!downloadQueue.includes(id)) {
      downloadQueue.push(id);
    }
  }

  if (toDownloadSegments.length > 0 && !isProcessingQueue) {
    processDownloadQueue();
  }

  for (let idx = 0; idx < selectedList.length; idx++) {
    const id = selectedList[idx];
    statusEl.textContent = `Downloading map tiles for ${id}...`;
    try {
      await downloadMapTilesForSegment(id, (done, total) => {
        if (total > 0) {
          const pct = Math.round((done / total) * 100);
          const doneMb = (done / (1024 * 1024)).toFixed(1);
          const totalMb = (total / (1024 * 1024)).toFixed(1);
          statusEl.textContent = `Downloading map tiles for ${id} (${idx + 1}/${selectedList.length}): ${pct}% (${doneMb}/${totalMb} MB)`;
        } else {
          const doneMb = (done / (1024 * 1024)).toFixed(1);
          statusEl.textContent = `Downloading map tiles for ${id} (${idx + 1}/${selectedList.length}): ${doneMb} MB`;
        }
      });
    } catch (err: any) {
      console.error(`Failed to download map tiles for ${id}:`, err);
      statusEl.textContent = `Failed map tiles download for ${id}: ${err.message}`;
    }
  }
  statusEl.textContent = `Map tiles cached for selected region(s).`;
});

btnBulkDelete?.addEventListener('click', () => {
  const toDelete = Array.from(selectedSegmentIds).filter((id) => cachedSegments.has(id));

  for (const id of toDelete) {
    deleteSegment(id);
  }
});

function processDownloadQueue() {
  if (downloadQueue.length === 0) {
    isProcessingQueue = false;
    return;
  }
  isProcessingQueue = true;
  const nextId = downloadQueue.shift()!;
  if (!cachedSegments.has(nextId)) {
    downloadSegment(nextId);
  } else {
    processDownloadQueue();
  }
}

// Render Tile Manager list as compact selectable rows
function renderSegmentList() {
  const { segments, overflowCount } = getListSegments();
  const cachedCount = cachedSegments.size;
  let totalCachedBytes = 0;
  for (const info of cachedSegments.values()) {
    totalCachedBytes += info.sizeBytes;
  }
  const totalCachedMb = (totalCachedBytes / (1024 * 1024)).toFixed(1);

  storageSummaryEl.textContent = `Route segments: ${cachedCount} cached (${totalCachedMb} MB)`;
  updateMapTileStorageSummary();

  segmentListEl.innerHTML = '';

  if (overflowCount > 0) {
    const noteEl = document.createElement('div');
    noteEl.style.padding = '8px 10px';
    noteEl.style.marginBottom = '6px';
    noteEl.style.background = '#f8fafc';
    noteEl.style.border = '1px solid #e2e8f0';
    noteEl.style.borderRadius = '6px';
    noteEl.style.color = '#64748b';
    noteEl.style.fontSize = '0.75rem';
    noteEl.style.lineHeight = '1.3';
    noteEl.textContent = `Zoom in to list local tiles (${overflowCount} in view), or click any tile on the map.`;
    segmentListEl.appendChild(noteEl);
  }

  if (segments.length === 0 && overflowCount === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.style.padding = '16px 8px';
    emptyMsg.style.color = '#64748b';
    emptyMsg.style.fontSize = '0.85rem';
    emptyMsg.style.textAlign = 'center';
    emptyMsg.textContent = 'Zoom in to view tiles in this area, or click the map.';
    segmentListEl.appendChild(emptyMsg);
    updateBulkToolbar();
    return;
  }

  for (const seg of segments) {
    const isSelected = selectedSegmentIds.has(seg.id);
    const row = document.createElement('div');
    row.className = `segment-row ${seg.status}${isSelected ? ' selected' : ''}`;
    row.setAttribute('data-id', seg.id);

    const badgeClass =
      seg.status === 'cached'
        ? 'badge-cached'
        : seg.status === 'downloading'
          ? 'badge-downloading'
          : 'badge-available';

    const badgeLabel =
      seg.status === 'cached'
        ? 'Cached'
        : seg.status === 'downloading'
          ? 'Downloading'
          : 'Available';

    const sizeLabel = seg.cachedBytes
      ? `${(seg.cachedBytes / (1024 * 1024)).toFixed(1)} MB`
      : '5°×5°';

    row.innerHTML = `
      <input type="checkbox" class="segment-check" data-id="${seg.id}" ${isSelected ? 'checked' : ''} aria-label="Select ${seg.id}" />
      <div class="segment-info">
        <div class="segment-row-top">
          <span class="segment-id">${seg.id}</span>
          <span class="segment-size">${sizeLabel}</span>
        </div>
        <div class="segment-desc">${seg.name}</div>
      </div>
      <span class="badge ${badgeClass}">${badgeLabel}</span>
    `;

    row.addEventListener('click', () => {
      toggleSegmentSelection(seg.id, false);

      const centerLngLat = new maplibregl.LngLat(
        (seg.bbox[0] + seg.bbox[2]) / 2,
        (seg.bbox[1] + seg.bbox[3]) / 2,
      );
      if (!map.getBounds().contains(centerLngLat)) {
        map.easeTo({ center: centerLngLat, duration: 400 });
      }
    });

    segmentListEl.appendChild(row);
  }

  updateBulkToolbar();
}

function downloadSegment(segmentId: string) {
  downloadingSegments.add(segmentId);
  updateGridSource();
  renderSegmentList();
  worker.postMessage({ type: 'DOWNLOAD_SEGMENT', segmentId });
}

async function deleteSegment(segmentId: string) {
  worker.postMessage({ type: 'DELETE_SEGMENT', segmentId });
  try {
    await deleteArchiveFromIDB(segmentId);
    loadedPMTiles.delete(segmentId);
    await updateMapTileStorageSummary();
    if (isOfflineMode) {
      map.triggerRepaint();
    }
  } catch (_e) {}
}

// Initial render of the segment list
renderSegmentList();

function setOfflineMode(enabled: boolean) {
  isOfflineMode = enabled;
  localStorage.setItem('rsrouter_offline_mode', String(enabled));

  if (checkOfflineMode) {
    checkOfflineMode.checked = enabled;
  }

  if (badgeOfflineStatus) {
    if (enabled) {
      badgeOfflineStatus.textContent = 'Offline';
      badgeOfflineStatus.className = 'offline-badge badge-offline';
    } else {
      badgeOfflineStatus.textContent = 'Online';
      badgeOfflineStatus.className = 'offline-badge badge-online';
    }
  }

  worker.postMessage({ type: 'SET_OFFLINE_MODE', offline: enabled });

  if (enabled) {
    map.setStyle(getOfflineStyle());
    statusEl.textContent = 'Offline mode active. Rendering with local PMTiles archives.';
  } else {
    map.setStyle('offline-tile://tiles.openfreemap.org/styles/bright');
    statusEl.textContent = 'Online mode active. Streaming tiles on the fly.';
  }
}

checkOfflineMode?.addEventListener('change', () => {
  setOfflineMode(checkOfflineMode.checked);
});

// Set initial offline UI state
setOfflineMode(isOfflineMode);

const IDB_NAME = 'rsrouter-pmtiles-v1';
const IDB_STORE = 'archives';

function openTileDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveArchiveToIDB(id: string, blob: Blob): Promise<void> {
  const db = await openTileDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(blob, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getArchiveFromIDB(id: string): Promise<Blob | undefined> {
  const db = await openTileDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(id);
    req.onsuccess = () => resolve(req.result as Blob | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function deleteArchiveFromIDB(id: string): Promise<void> {
  const db = await openTileDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllArchiveEntriesFromIDB(): Promise<Array<{ id: string; size: number }>> {
  const db = await openTileDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    const entries: Array<{ id: string; size: number }> = [];
    const req = store.openCursor();
    req.onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        const id = String(cursor.key);
        const blob = cursor.value as Blob;
        entries.push({ id, size: blob?.size || 0 });
        cursor.continue();
      } else {
        resolve(entries);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

async function loadPMTilesArchive(segmentId: string, blob: Blob): Promise<pmtiles.PMTiles> {
  const fileSource = new pmtiles.FileSource(new File([blob], `${segmentId}.pmtiles`));
  const p = new pmtiles.PMTiles(fileSource);
  await p.getHeader();
  loadedPMTiles.set(segmentId, p);
  return p;
}

async function initCachedMapTiles() {
  try {
    const entries = await getAllArchiveEntriesFromIDB();
    for (const entry of entries) {
      if (!loadedPMTiles.has(entry.id)) {
        const blob = await getArchiveFromIDB(entry.id);
        if (blob) {
          await loadPMTilesArchive(entry.id, blob);
          console.log(`[PMTiles] Loaded cached archive for ${entry.id}`);
        }
      }
    }
    await updateMapTileStorageSummary();
    if (isOfflineMode) {
      map.triggerRepaint();
    }
  } catch (err) {
    console.warn('Failed to initialize cached map tiles:', err);
  }
}

initCachedMapTiles();

async function updateMapTileStorageSummary() {
  if (!mapStorageSummaryEl) return;
  try {
    const entries = await getAllArchiveEntriesFromIDB();
    const totalBytes = entries.reduce((acc, e) => acc + e.size, 0);
    const mb = (totalBytes / (1024 * 1024)).toFixed(1);
    mapStorageSummaryEl.textContent = `Map tiles: ${entries.length} ${entries.length === 1 ? 'region' : 'regions'} (${mb} MB)`;
  } catch (err) {
    console.warn('Failed to calculate map tile storage:', err);
  }
}

async function downloadMapTilesForSegment(
  segmentId: string,
  onProgress?: (done: number, total: number) => void,
) {
  // 1. Pre-cache Protomaps font glyphs in CacheStorage
  if ('caches' in window) {
    try {
      const cache = await caches.open(MAP_TILES_CACHE_NAME);
      const fontNames = ['Noto Sans Regular', 'Noto Sans Medium', 'Noto Sans Italic'];
      for (const fontName of fontNames) {
        const fontUrlEncoded = `https://cdn.protomaps.com/fonts/pbf/${encodeURIComponent(fontName)}/0-255.pbf`;
        const fontUrlRaw = `https://cdn.protomaps.com/fonts/pbf/${fontName}/0-255.pbf`;
        const existing = (await cache.match(fontUrlEncoded)) || (await cache.match(fontUrlRaw));
        if (!existing) {
          const res = await fetch(fontUrlEncoded);
          if (res.ok) {
            await cache.put(fontUrlEncoded, res.clone());
            await cache.put(fontUrlRaw, res);
          }
        }
      }
    } catch (_e) {}
  }

  // 2. Check if PMTiles archive is already in IndexedDB
  const existingBlob = await getArchiveFromIDB(segmentId);
  if (existingBlob) {
    if (!loadedPMTiles.has(segmentId)) {
      await loadPMTilesArchive(segmentId, existingBlob);
    }
    await updateMapTileStorageSummary();
    return;
  }

  // 3. Download PMTiles archive from server with streaming progress
  statusEl.textContent = `Extracting & downloading map tiles for ${segmentId}...`;
  const res = await fetch(`/map-tiles/${segmentId}.pmtiles`);
  if (!res.ok) {
    throw new Error(`Failed to download map tiles for ${segmentId}: HTTP ${res.status}`);
  }

  const contentLength = Number(res.headers.get('content-length')) || 0;
  let receivedBytes = 0;

  const reader = res.body!.getReader();
  const chunks: BlobPart[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    receivedBytes += value.byteLength;
    if (onProgress) {
      onProgress(receivedBytes, contentLength);
    }
  }

  const blob = new Blob(chunks, { type: 'application/vnd.pmtiles' });

  // 4. Save to IndexedDB and load into memory
  await saveArchiveToIDB(segmentId, blob);
  await loadPMTilesArchive(segmentId, blob);

  await updateMapTileStorageSummary();
  if (isOfflineMode) {
    map.triggerRepaint();
  }
}
(window as any).downloadMapTilesForSegment = downloadMapTilesForSegment;

// Service worker registration
if ('serviceWorker' in navigator) {
  if (import.meta.env.DEV) {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const reg of registrations) {
        reg.unregister();
      }
    });
  } else {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('Service worker registration failed:', err);
      });
    });
  }
}
