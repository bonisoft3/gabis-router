// Route comparison module: loads, parses, and compares an external GPX track against rsrouter.

import maplibregl from 'maplibre-gl';
import { formatDistance, formatElevation, formatDuration, onUnitsChange } from './format.ts';
import { setCompareProfile } from './route-info.ts';
import type { LatLon } from './types.ts';

export interface ComparedRoute {
  name: string;
  distanceM: number;
  ascentM: number;
  descentM: number;
  durationS?: number;
  /** [lon, lat, ele?] */
  coordinates: number[][];
  /** Distance from start per vertex in meters */
  dist: number[];
  /** Elevation per vertex in meters */
  ele: number[];
  geojson: GeoJSON.FeatureCollection;
}

interface CompareDeps {
  map: maplibregl.Map;
  isStyleReady: () => boolean;
  setWaypoints: (wps: LatLon[]) => void;
}

let deps: CompareDeps;
let comparedRoute: ComparedRoute | null = null;
let currentRouterRoute: GeoJSON.FeatureCollection | null = null;

// UI elements
const inputCompareGpx = document.getElementById('input-compare-gpx') as HTMLInputElement | null;
const btnCompareGpx = document.getElementById('btn-compare-gpx') as HTMLButtonElement | null;
const compareCard = document.getElementById('compare-card') as HTMLDivElement | null;
const compareNameEl = document.getElementById('compare-name') as HTMLDivElement | null;
const btnClearCompare = document.getElementById('btn-clear-compare') as HTMLButtonElement | null;
const btnMatchCompare = document.getElementById('btn-match-compare') as HTMLButtonElement | null;

const cmpRouterDist = document.getElementById('cmp-router-dist');
const cmpGpxDist = document.getElementById('cmp-gpx-dist');
const cmpDiffDist = document.getElementById('cmp-diff-dist');

const cmpRouterAscent = document.getElementById('cmp-router-ascent');
const cmpGpxAscent = document.getElementById('cmp-gpx-ascent');
const cmpDiffAscent = document.getElementById('cmp-diff-ascent');

const cmpRowTime = document.getElementById('cmp-row-time');
const cmpRouterTime = document.getElementById('cmp-router-time');
const cmpGpxTime = document.getElementById('cmp-gpx-time');
const cmpDiffTime = document.getElementById('cmp-diff-time');

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function parseGpx(xmlText: string): ComparedRoute {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');
  const parserError = doc.querySelector('parsererror');
  if (parserError) {
    throw new Error('Invalid GPX XML format');
  }

  const nameEl = doc.querySelector('trk > name') || doc.querySelector('metadata > name') || doc.querySelector('name');
  const name = nameEl?.textContent?.trim() || 'Recorded Route';

  let ptEls = Array.from(doc.querySelectorAll('trkpt'));
  if (ptEls.length === 0) ptEls = Array.from(doc.querySelectorAll('rtept'));
  if (ptEls.length === 0) ptEls = Array.from(doc.querySelectorAll('wpt'));

  if (ptEls.length < 2) {
    throw new Error('GPX contains fewer than 2 route points');
  }

  const coordinates: number[][] = [];
  const ele: number[] = [];
  const timestamps: number[] = [];
  const dist: number[] = [0];

  for (const el of ptEls) {
    const lat = parseFloat(el.getAttribute('lat') || '');
    const lon = parseFloat(el.getAttribute('lon') || '');
    if (isNaN(lat) || isNaN(lon)) continue;

    const eleEl = el.querySelector('ele');
    const altitude = eleEl ? parseFloat(eleEl.textContent || '') : undefined;
    const timeEl = el.querySelector('time');
    const timeMs = timeEl ? Date.parse(timeEl.textContent || '') : NaN;

    if (altitude !== undefined && !isNaN(altitude)) {
      coordinates.push([lon, lat, altitude]);
      ele.push(altitude);
    } else {
      coordinates.push([lon, lat]);
      ele.push(0);
    }

    if (!isNaN(timeMs)) {
      timestamps.push(timeMs);
    }

    if (coordinates.length > 1) {
      const prev = coordinates[coordinates.length - 2];
      const curr = coordinates[coordinates.length - 1];
      const d = haversine(prev[1], prev[0], curr[1], curr[0]);
      dist.push(dist[dist.length - 1] + d);
    }
  }

  if (coordinates.length < 2) {
    throw new Error('Valid coordinates in GPX fewer than 2 points');
  }

  const distanceM = dist[dist.length - 1] || 0;

  let ascentM = 0;
  let descentM = 0;
  for (let i = 1; i < ele.length; i++) {
    const diff = ele[i] - ele[i - 1];
    if (diff > 0.5) ascentM += diff;
    else if (diff < -0.5) descentM += Math.abs(diff);
  }

  let durationS: number | undefined;
  if (timestamps.length >= 2) {
    const totalMs = timestamps[timestamps.length - 1] - timestamps[0];
    if (totalMs > 0) durationS = Math.round(totalMs / 1000);
  }

  const geojson: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          name,
          distanceM,
          ascentM,
          descentM,
          durationS,
        },
        geometry: {
          type: 'LineString',
          coordinates,
        },
      },
    ],
  };

  return {
    name,
    distanceM,
    ascentM,
    descentM,
    durationS,
    coordinates,
    dist,
    ele,
    geojson,
  };
}

function ensureLayerOrder(map: maplibregl.Map) {
  if (map.getLayer('compare-route-casing')) {
    if (map.getLayer('compare-route-line')) {
      map.moveLayer('compare-route-line');
    }
    if (map.getLayer('route-segment-halo')) {
      map.moveLayer('route-segment-halo');
    }
    if (map.getLayer('route-segment-line')) {
      map.moveLayer('route-segment-line');
    }
  }
}

export function drawCompareLayer() {
  if (!deps?.isStyleReady?.()) return;
  const map = deps.map;
  const data: GeoJSON.FeatureCollection = comparedRoute?.geojson || {
    type: 'FeatureCollection',
    features: [],
  };

  const source = map.getSource('compare-route') as maplibregl.GeoJSONSource | undefined;
  if (source) {
    source.setData(data);
    ensureLayerOrder(map);
    return;
  }

  map.addSource('compare-route', { type: 'geojson', data });

  const beforeId = map.getLayer('route-segment-halo') ? 'route-segment-halo' : undefined;

  // Outer casing for contrast against map and route lines
  map.addLayer(
    {
      id: 'compare-route-casing',
      type: 'line',
      source: 'compare-route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#ffffff',
        'line-width': 8,
        'line-opacity': 0.85,
      },
    },
    beforeId,
  );

  // Dashed violet line to distinguish clearly from router route
  map.addLayer(
    {
      id: 'compare-route-line',
      type: 'line',
      source: 'compare-route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#8b5cf6',
        'line-width': 4.5,
        'line-opacity': 0.95,
        'line-dasharray': [2, 1],
      },
    },
    beforeId,
  );

  ensureLayerOrder(map);
}

function getBounds(coords: number[][]): [[number, number], [number, number]] {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const c of coords) {
    if (c[0] < minLon) minLon = c[0];
    if (c[0] > maxLon) maxLon = c[0];
    if (c[1] < minLat) minLat = c[1];
    if (c[1] > maxLat) maxLat = c[1];
  }
  return [[minLon, minLat], [maxLon, maxLat]];
}

export function setComparedRoute(route: ComparedRoute | null, fit = false) {
  comparedRoute = route;

  if (route) {
    setCompareProfile({
      dist: route.dist,
      ele: route.ele,
      coords: route.coordinates,
    });
    if (fit && deps?.map) {
      const bounds = getBounds(route.coordinates);
      deps.map.fitBounds(bounds, { padding: 48, maxZoom: 15 });
    }
  } else {
    setCompareProfile(null);
  }

  drawCompareLayer();
  updateCompareUI();
}

export function getComparedRoute(): ComparedRoute | null {
  return comparedRoute;
}

export function notifyRouterRouteChanged(geojson: GeoJSON.FeatureCollection | null) {
  currentRouterRoute = geojson;
  updateCompareUI();
}

export function updateCompareUI() {
  if (!compareCard) return;

  if (!comparedRoute) {
    compareCard.hidden = true;
    return;
  }

  compareCard.hidden = false;
  if (compareNameEl) compareNameEl.textContent = comparedRoute.name;

  // GPX stats
  if (cmpGpxDist) cmpGpxDist.textContent = formatDistance(comparedRoute.distanceM);
  if (cmpGpxAscent) cmpGpxAscent.textContent = formatElevation(comparedRoute.ascentM);

  if (cmpRowTime) {
    if (comparedRoute.durationS !== undefined) {
      cmpRowTime.style.display = '';
      if (cmpGpxTime) cmpGpxTime.textContent = formatDuration(comparedRoute.durationS);
    } else {
      cmpRowTime.style.display = 'none';
    }
  }

  // Router stats & differences
  if (currentRouterRoute && currentRouterRoute.features.length > 0) {
    const props = (currentRouterRoute.features[0].properties || {}) as Record<string, any>;
    const routerDist = Number(props['track-length'] || 0);
    const routerAscent = Number(props['filtered ascend'] || 0);
    const routerTime = Number(props['total-time'] || 0);

    if (cmpRouterDist) cmpRouterDist.textContent = formatDistance(routerDist);
    if (cmpRouterAscent) cmpRouterAscent.textContent = formatElevation(routerAscent);
    if (cmpRouterTime) cmpRouterTime.textContent = formatDuration(routerTime);

    // Diffs
    if (cmpDiffDist) {
      const diffD = routerDist - comparedRoute.distanceM;
      const sign = diffD > 0 ? '+' : diffD < 0 ? '-' : '';
      cmpDiffDist.textContent = `${sign}${formatDistance(Math.abs(diffD))}`;
      cmpDiffDist.className = diffD <= 0 ? 'compare-diff-neg' : 'compare-diff-pos';
    }

    if (cmpDiffAscent) {
      const diffA = routerAscent - comparedRoute.ascentM;
      const sign = diffA > 0 ? '+' : diffA < 0 ? '-' : '';
      cmpDiffAscent.textContent = `${sign}${formatElevation(Math.abs(diffA))}`;
      cmpDiffAscent.className = diffA <= 0 ? 'compare-diff-neg' : 'compare-diff-pos';
    }

    if (cmpDiffTime && comparedRoute.durationS !== undefined) {
      const diffT = routerTime - comparedRoute.durationS;
      const sign = diffT > 0 ? '+' : diffT < 0 ? '-' : '';
      cmpDiffTime.textContent = `${sign}${formatDuration(Math.abs(diffT))}`;
      cmpDiffTime.className = diffT <= 0 ? 'compare-diff-neg' : 'compare-diff-pos';
    }
  } else {
    if (cmpRouterDist) cmpRouterDist.textContent = '-';
    if (cmpRouterAscent) cmpRouterAscent.textContent = '-';
    if (cmpRouterTime) cmpRouterTime.textContent = '-';
    if (cmpDiffDist) {
      cmpDiffDist.textContent = '-';
      cmpDiffDist.className = '';
    }
    if (cmpDiffAscent) {
      cmpDiffAscent.textContent = '-';
      cmpDiffAscent.className = '';
    }
    if (cmpDiffTime) {
      cmpDiffTime.textContent = '-';
      cmpDiffTime.className = '';
    }
  }
}

export function loadGpxContent(xmlText: string, fit = true) {
  try {
    const route = parseGpx(xmlText);
    setComparedRoute(route, fit);
  } catch (err: any) {
    alert(`Could not load GPX: ${err.message || err}`);
  }
}

export function initCompare(d: CompareDeps) {
  deps = d;

  btnCompareGpx?.addEventListener('click', () => {
    inputCompareGpx?.click();
  });

  inputCompareGpx?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const content = evt.target?.result as string;
      if (content) loadGpxContent(content, true);
    };
    reader.readAsText(file);
    // Reset file input so selecting the same file again works
    (e.target as HTMLInputElement).value = '';
  });

  btnClearCompare?.addEventListener('click', () => {
    setComparedRoute(null);
  });

  btnMatchCompare?.addEventListener('click', () => {
    if (!comparedRoute || comparedRoute.coordinates.length < 2) return;
    const first = comparedRoute.coordinates[0];
    const last = comparedRoute.coordinates[comparedRoute.coordinates.length - 1];
    deps.setWaypoints([
      { lon: first[0], lat: first[1] },
      { lon: last[0], lat: last[1] },
    ]);
  });

  // Drag and drop GPX file anywhere onto window
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file && file.name.toLowerCase().endsWith('.gpx')) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        const content = evt.target?.result as string;
        if (content) loadGpxContent(content, true);
      };
      reader.readAsText(file);
    }
  });

  onUnitsChange(updateCompareUI);
}

(window as any).loadGpxContent = loadGpxContent;
(window as any).setComparedRoute = setComparedRoute;
(window as any).getComparedRoute = getComparedRoute;
(window as any).parseGpx = parseGpx;

