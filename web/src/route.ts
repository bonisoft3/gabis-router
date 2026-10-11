import maplibregl from 'maplibre-gl';
import { formatDistance, formatDuration, formatElevation, onUnitsChange } from './format.ts';
import { hideMenu, menuClosedWithin, showMenu } from './menu.ts';
import { hideRouteInfo, initRouteInfo, showRouteInfo, type SegmentHighlight } from './route-info.ts';
import type { LatLon, ProfileName, WorkerMessage } from './types.ts';
import { notifyRouterRouteChanged } from './compare.ts';


interface Deps {
  map: maplibregl.Map;
  worker: Worker;
  /** The route layer can only be added after the style has loaded. */
  isStyleReady: () => boolean;
}

// UI elements
const statusEl = document.getElementById('status')!;
const profileSelect = document.getElementById('profile-select') as HTMLSelectElement;
const btnClearRoute = document.getElementById('btn-clear-route') as HTMLButtonElement;
const btnUndo = document.getElementById('btn-undo') as HTMLButtonElement;
const btnExportGpx = document.getElementById('btn-export-gpx') as HTMLButtonElement;
const btnShare = document.getElementById('btn-share') as HTMLButtonElement;
const btnMyLocation = document.getElementById('btn-my-location') as HTMLButtonElement;
const waypointListEl = document.getElementById('waypoint-list') as HTMLDivElement;

const STORAGE_KEY = 'rsrouter_route';
const MAX_UNDO = 50;
// Hit area of the route line for dragging and tapping, in pixels around the pointer.
const ROUTE_HIT_PX = 8;
const LONG_PRESS_MS = 600;

let deps: Deps;

let waypoints: LatLon[] = [];
let markers: maplibregl.Marker[] = [];
let undoStack: LatLon[][] = [];

// Only the latest route request is shown. Cleared or superseded results are dropped.
let activeRouteId: string | null = null;
let routeCounter = 0;
let activeRouteProfile = '';
// Which of BRouter's alternatives (0 to 3) is requested, and which one the drawn route is.
let requestedAlternative = 0;
let shownAlternative = 0;
let hoverMarker: maplibregl.Marker | null = null;
let currentRouteGeoJson: GeoJSON.FeatureCollection | null = null;
let currentRouteProfile = '';

// ---------------------------------------------------------------------------
// Waypoints
// ---------------------------------------------------------------------------

function waypointKind(i: number, n: number): 'start' | 'end' | 'via' {
  if (i === 0) return 'start';
  return i === n - 1 ? 'end' : 'via';
}

function waypointLabel(i: number, n: number): string {
  const kind = waypointKind(i, n);
  return kind === 'start' ? 'A' : kind === 'end' ? 'B' : String(i);
}

/** Replaces all waypoints. This is the only place that changes them. */
export function setWaypoints(next: LatLon[], recordUndo = true) {
  if (recordUndo) {
    undoStack.push(waypoints);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
  }
  waypoints = next;
  requestedAlternative = 0;
  renderWaypoints();
  saveRoute();
  if (waypoints.length >= 2) {
    requestRoute();
  } else {
    clearRouteLine();
    statusEl.textContent =
      waypoints.length === 1
        ? 'Start point set. Double-click or click to add the next point.'
        : 'Double-click or click on the map to set start and end points.';
  }
}

export function getWaypoints(): readonly LatLon[] {
  return waypoints;
}

function undo() {
  const previous = undoStack.pop();
  if (!previous) return;
  setWaypoints(previous, false);
}

/** Makes `p` the start. With no points, it is the first point. */
function setStart(p: LatLon) {
  setWaypoints(waypoints.length === 0 ? [p] : [p, ...waypoints.slice(1)]);
}

/** Adds `p` just before the end. With fewer than two points it is appended. */
function addVia(p: LatLon) {
  if (waypoints.length < 2) return setWaypoints([...waypoints, p]);
  setWaypoints([...waypoints.slice(0, -1), p, waypoints[waypoints.length - 1]]);
}

/** Makes `p` the end. With one point it is appended, with none it is the first point. */
function setEnd(p: LatLon) {
  if (waypoints.length < 2) return setWaypoints([...waypoints, p]);
  setWaypoints([...waypoints.slice(0, -1), p]);
}

function removeWaypoint(index: number) {
  setWaypoints(waypoints.filter((_, i) => i !== index));
}

async function copyCoordinates(p: LatLon) {
  const text = `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
  try {
    await navigator.clipboard.writeText(text);
    statusEl.textContent = `Copied ${text}`;
  } catch (err) {
    statusEl.textContent = `Could not copy: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Shares the page address, which holds the route. Falls back to copying it. */
async function shareRoute() {
  const url = location.href;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'rsrouter route', url });
    } else {
      await navigator.clipboard.writeText(url);
      statusEl.textContent = 'Link copied. Anyone who opens it sees this route.';
    }
  } catch (err) {
    // Closing the share sheet is not an error.
    if (err instanceof DOMException && err.name === 'AbortError') return;
    statusEl.textContent = `Could not share: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function openStreetView(p: LatLon) {
  const url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

let lastOpenedMarkerIndex: number | null = null;

function showMapMenu(p: LatLon, x: number, y: number) {
  lastOpenedMarkerIndex = null;
  showMenu(
    [
      { label: 'Add point', onSelect: () => setWaypoints([...waypoints, p]) },
      { label: 'Start here', onSelect: () => setStart(p) },
      { label: 'Via here', onSelect: () => addVia(p) },
      { label: 'End here', onSelect: () => setEnd(p) },
      { label: 'See on Google Street View', onSelect: () => openStreetView(p) },
      { label: 'Copy coordinates', onSelect: () => copyCoordinates(p) },
    ],
    x,
    y,
  );
}

function showMarkerMenu(index: number, x: number, y: number) {
  const p = waypoints[index];
  if (!p) return;
  lastOpenedMarkerIndex = index;
  showMenu(
    [
      {
        label: 'Remove point',
        onSelect: () => {
          const currentIndex = waypoints.indexOf(p);
          removeWaypoint(currentIndex !== -1 ? currentIndex : index);
        },
      },
      { label: 'See on Google Street View', onSelect: () => openStreetView(p) },
      { label: 'Copy coordinates', onSelect: () => copyCoordinates(p) },
    ],
    x,
    y,
  );
}

// ---------------------------------------------------------------------------
// Finding the user
// ---------------------------------------------------------------------------

const GEOLOCATION_ERRORS: Record<number, string> = {
  1: 'Location permission was denied. Allow it in the browser settings and try again.',
  2: 'Your location is not available right now.',
  3: 'Finding your location took too long. Try again.',
};

/** Sets the start to the current position and centres the map on it. */
function startFromMyLocation() {
  if (!('geolocation' in navigator)) {
    statusEl.textContent = 'This browser cannot find your location.';
    return;
  }
  statusEl.textContent = 'Finding your location...';
  btnMyLocation.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btnMyLocation.disabled = false;
      const here = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      setStart(here);
      // With a full route, keep the view as is when the user is part of it.
      if (waypoints.length < 2) {
        deps.map.easeTo({ center: [here.lon, here.lat], zoom: Math.max(deps.map.getZoom(), 14) });
      }
    },
    (err) => {
      btnMyLocation.disabled = false;
      statusEl.textContent = GEOLOCATION_ERRORS[err.code] ?? `Could not find your location: ${err.message}`;
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
  );
}

function createMarker(index: number): maplibregl.Marker {
  const n = waypoints.length;
  const el = document.createElement('div');
  el.className = `wp-marker ${waypointKind(index, n)}`;
  el.textContent = waypointLabel(index, n);

  let wasDragged = false;

  const marker = new maplibregl.Marker({ element: el, draggable: true, clickTolerance: 4 })
    .setLngLat([waypoints[index].lon, waypoints[index].lat])
    .addTo(deps.map);

  marker.on('dragstart', () => {
    wasDragged = true;
    hideMenu();
  });

  marker.on('dragend', () => {
    const { lat, lng } = marker.getLngLat();
    setWaypoints(waypoints.map((w, i) => (i === index ? { lat, lon: lng } : w)));
    setTimeout(() => {
      wasDragged = false;
    }, 150);
  });

  // A single click on a marker opens options (unless it was dragged or toggled off).
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (wasDragged) return;
    if (lastOpenedMarkerIndex === index && menuClosedWithin(250)) {
      lastOpenedMarkerIndex = null;
      return;
    }
    const rect = el.getBoundingClientRect();
    const x = e.clientX || rect.left + rect.width / 2;
    const y = e.clientY || rect.bottom + 4;
    showMarkerMenu(index, x, y);
  });

  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showMarkerMenu(index, e.clientX, e.clientY);
  });

  return marker;
}

let draggedRowIndex: number | null = null;

function setupRowDrag(row: HTMLElement, index: number) {
  row.addEventListener('dragstart', (e) => {
    if ((e.target as HTMLElement).closest('button')) {
      e.preventDefault();
      return;
    }
    draggedRowIndex = index;
    row.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(index));
    }
  });

  row.addEventListener('dragover', (e) => {
    if (draggedRowIndex === null || draggedRowIndex === index) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const rect = row.getBoundingClientRect();
    if (e.clientY < rect.top + rect.height / 2) {
      row.classList.add('drop-above');
      row.classList.remove('drop-below');
    } else {
      row.classList.add('drop-below');
      row.classList.remove('drop-above');
    }
  });

  row.addEventListener('dragleave', () => {
    row.classList.remove('drop-above', 'drop-below');
  });

  row.addEventListener('drop', (e) => {
    e.preventDefault();
    row.classList.remove('drop-above', 'drop-below');
    if (draggedRowIndex === null || draggedRowIndex === index) return;
    const isAbove = e.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
    let targetIndex = isAbove ? index : index + 1;
    if (draggedRowIndex < targetIndex) targetIndex--;
    if (draggedRowIndex !== targetIndex) {
      const next = [...waypoints];
      const [moved] = next.splice(draggedRowIndex, 1);
      next.splice(targetIndex, 0, moved);
      setWaypoints(next);
    }
    draggedRowIndex = null;
  });

  row.addEventListener('dragend', () => {
    draggedRowIndex = null;
    waypointListEl.querySelectorAll('.wp-row').forEach((r) => {
      r.classList.remove('dragging', 'drop-above', 'drop-below');
    });
  });
}

function setupHandleTouchDrag(handle: HTMLElement, index: number) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return; // Mouse uses HTML5 drag
    const startY = e.clientY;
    let isDragging = false;
    const row = handle.closest('.wp-row') as HTMLElement;
    let currentTargetRow: HTMLElement | null = null;
    let isAbove = false;

    const onPointerMove = (ev: PointerEvent) => {
      if (!isDragging && Math.abs(ev.clientY - startY) > 6) {
        isDragging = true;
        row?.classList.add('dragging');
      }
      if (!isDragging) return;
      ev.preventDefault();

      if (currentTargetRow) {
        currentTargetRow.classList.remove('drop-above', 'drop-below');
      }

      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const targetRow = el?.closest('.wp-row') as HTMLElement | null;
      if (targetRow && targetRow !== row) {
        currentTargetRow = targetRow;
        const rect = targetRow.getBoundingClientRect();
        isAbove = ev.clientY < rect.top + rect.height / 2;
        if (isAbove) targetRow.classList.add('drop-above');
        else targetRow.classList.add('drop-below');
      } else {
        currentTargetRow = null;
      }
    };

    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      row?.classList.remove('dragging');
      if (currentTargetRow) {
        currentTargetRow.classList.remove('drop-above', 'drop-below');
        const targetIdx = Number(currentTargetRow.dataset.index);
        let targetIndex = isAbove ? targetIdx : targetIdx + 1;
        if (index < targetIndex) targetIndex--;
        if (index !== targetIndex) {
          const next = [...waypoints];
          const [moved] = next.splice(index, 1);
          next.splice(targetIndex, 0, moved);
          setWaypoints(next);
        }
      }
    };

    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
  });
}

function renderWaypoints() {
  markers.forEach((m) => m.remove());
  markers = waypoints.map((_, i) => createMarker(i));

  const n = waypoints.length;
  waypointListEl.innerHTML = waypoints
    .map(
      (w, i) => `
      <div class="wp-row" data-index="${i}" draggable="true">
        <span class="wp-drag-handle" title="Drag to reorder" aria-label="Drag to reorder">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="9" cy="6" r="2"/>
            <circle cx="15" cy="6" r="2"/>
            <circle cx="9" cy="12" r="2"/>
            <circle cx="15" cy="12" r="2"/>
            <circle cx="9" cy="18" r="2"/>
            <circle cx="15" cy="18" r="2"/>
          </svg>
        </span>
        <span class="wp-badge ${waypointKind(i, n)}">${waypointLabel(i, n)}</span>
        <span class="wp-coords">${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}</span>
        <button class="wp-btn" data-action="up" aria-label="Move point up" ${i === 0 ? 'disabled' : ''}>&#8593;</button>
        <button class="wp-btn" data-action="down" aria-label="Move point down" ${i === n - 1 ? 'disabled' : ''}>&#8595;</button>
        <button class="wp-btn" data-action="remove" aria-label="Remove point">&#10005;</button>
      </div>`,
    )
    .join('');
  waypointListEl.style.display = n ? 'block' : 'none';
  btnUndo.disabled = undoStack.length === 0;
  btnShare.disabled = n < 2;

  waypointListEl.querySelectorAll<HTMLElement>('.wp-row').forEach((row) => {
    const idx = Number(row.dataset.index);
    setupRowDrag(row, idx);
    const handle = row.querySelector<HTMLElement>('.wp-drag-handle');
    if (handle) setupHandleTouchDrag(handle, idx);
  });
}

waypointListEl.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  const row = (e.target as HTMLElement).closest<HTMLElement>('.wp-row');
  if (!button || !row) return;
  const i = Number(row.dataset.index);
  const next = [...waypoints];
  switch (button.dataset.action) {
    case 'remove':
      next.splice(i, 1);
      break;
    case 'up':
      [next[i - 1], next[i]] = [next[i], next[i - 1]];
      break;
    case 'down':
      [next[i + 1], next[i]] = [next[i], next[i + 1]];
      break;
  }
  setWaypoints(next);
});

// ---------------------------------------------------------------------------
// Saved and shared routes
// ---------------------------------------------------------------------------

// The route lives in the URL hash, so copying the address is the share link.
// Format: #r=lat,lon;lat,lon&p=profile
function encodeHash(): string {
  if (waypoints.length === 0) return '';
  const r = waypoints.map((w) => `${w.lat.toFixed(5)},${w.lon.toFixed(5)}`).join(';');
  return `#r=${r}&p=${encodeURIComponent(profileSelect.value)}`;
}

function saveRoute() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ waypoints, profile: profileSelect.value }));
  history.replaceState(null, '', location.pathname + location.search + encodeHash());
}

interface SavedRoute {
  waypoints: LatLon[];
  profile?: string;
}

function validPoint(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/** Reads a route from the URL hash. Returns null if there is none or it is invalid. */
function parseHash(): SavedRoute | null {
  const raw = /(?:^#|&)r=([^&]*)/.exec(location.hash)?.[1];
  if (!raw) return null;
  const points: LatLon[] = [];
  for (const pair of raw.split(';')) {
    const [lat, lon] = pair.split(',').map(Number);
    if (!validPoint(lat, lon)) {
      statusEl.textContent = 'Ignored the route in the link: it has an invalid point.';
      return null;
    }
    points.push({ lat, lon });
  }
  const profile = /(?:^#|&)p=([^&]*)/.exec(location.hash)?.[1];
  return { waypoints: points, profile: profile ? decodeURIComponent(profile) : undefined };
}

function loadSavedRoute(): SavedRoute | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as SavedRoute) : null;
}

function fitPadding(): maplibregl.PaddingOptions {
  return window.innerWidth > 640
    ? { top: 60, bottom: 160, left: 420, right: 60 }
    : { top: 220, bottom: 140, left: 40, right: 40 };
}

export function fitToWaypoints() {
  if (waypoints.length === 0) return;
  const bounds = new maplibregl.LngLatBounds();
  waypoints.forEach((w) => bounds.extend([w.lon, w.lat]));
  deps.map.fitBounds(bounds, { padding: fitPadding(), maxZoom: 15, duration: 0 });
}

// ---------------------------------------------------------------------------
// Route requests and results
// ---------------------------------------------------------------------------

function requestRoute() {
  const profile = profileSelect.value as ProfileName;
  statusEl.textContent = 'Requesting route...';
  activeRouteId = String(++routeCounter);
  activeRouteProfile = profile;
  deps.worker.postMessage({
    type: 'ROUTE_REQUEST',
    id: activeRouteId,
    payload: { waypoints, profile, alternativeIdx: requestedAlternative },
  } satisfies WorkerMessage);
}

function handleWorkerMessage(e: MessageEvent<WorkerMessage>) {
  const msg = e.data;
  switch (msg.type) {
    case 'STATUS':
      statusEl.textContent = msg.message;
      break;

    case 'ROUTE_SUCCESS': {
      if (msg.id !== activeRouteId) break;
      shownAlternative = requestedAlternative;
      renderRoute(msg.payload);
      break;
    }

    case 'ROUTE_ERROR':
      if (msg.id !== activeRouteId) break;
      if (requestedAlternative > 0 && currentRouteGeoJson) {
        // No such alternative. Go back to the route that is on the map.
        statusEl.textContent = `No alternative route ${requestedAlternative + 1}: ${msg.error}`;
        requestedAlternative = shownAlternative;
        showRouteInfo(currentRouteGeoJson, shownAlternative);
        break;
      }
      // An old line must not stay on the map next to an error.
      clearRouteLine();
      statusEl.textContent = `Routing error: ${msg.error}`;
      break;
  }
}

function routeStatus(geojson: GeoJSON.FeatureCollection): string {
  const props = geojson.features[0]?.properties as Record<string, string> | undefined;
  if (!props || !(Number(props['track-length']) > 0)) return 'Route calculated successfully.';
  return (
    `Distance: ${formatDistance(Number(props['track-length']))} | ` +
    `Time: ${formatDuration(Number(props['total-time']))} | ` +
    `Ascend: ${formatElevation(Number(props['filtered ascend']))}`
  );
}

function renderRoute(geojson: GeoJSON.FeatureCollection) {
  currentRouteGeoJson = geojson;
  currentRouteProfile = activeRouteProfile;
  btnExportGpx.disabled = false;
  statusEl.textContent = routeStatus(geojson);
  showRouteInfo(geojson, shownAlternative);
  drawRouteLayer();
  notifyRouterRouteChanged(geojson);
}

let activeHighlightGeoJson: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export function updateSegmentHighlight(highlight: SegmentHighlight | null) {
  if (!highlight || highlight.coordinates.length === 0) {
    activeHighlightGeoJson = { type: 'FeatureCollection', features: [] };
  } else {
    activeHighlightGeoJson = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            color: highlight.color,
          },
          geometry: {
            type: 'MultiLineString',
            coordinates: highlight.coordinates,
          },
        },
      ],
    };
  }
  if (!deps?.isStyleReady?.()) return;
  const source = deps.map.getSource('route-segment-highlight') as maplibregl.GeoJSONSource | undefined;
  if (source) {
    source.setData(activeHighlightGeoJson);
    if (highlight && highlight.coordinates.length > 0) {
      if (deps.map.getLayer('route-segment-halo')) {
        deps.map.moveLayer('route-segment-halo');
      }
      if (deps.map.getLayer('route-segment-line')) {
        deps.map.moveLayer('route-segment-line');
      }
    }
  }
}

/** Draws currentRouteGeoJson. Called again on 'style.load' when the style changes. */
export function drawRouteLayer() {
  if (!deps.isStyleReady()) return;
  const map = deps.map;
  const data: GeoJSON.FeatureCollection = currentRouteGeoJson || { type: 'FeatureCollection', features: [] };
  const source = map.getSource('route') as maplibregl.GeoJSONSource | undefined;
  if (source) {
    source.setData(data);
  } else {
    map.addSource('route', { type: 'geojson', data });
    // Invisible and wide, so the line is easy to grab with a finger.
    map.addLayer({
      id: 'route-hit',
      type: 'line',
      source: 'route',
      paint: { 'line-color': '#000000', 'line-width': ROUTE_HIT_PX * 2, 'line-opacity': 0 },
    });
    map.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#2563eb', 'line-width': 5, 'line-opacity': 0.85 },
    });
  }

  const highlightSource = map.getSource('route-segment-highlight') as maplibregl.GeoJSONSource | undefined;
  if (highlightSource) {
    highlightSource.setData(activeHighlightGeoJson);
  } else {
    map.addSource('route-segment-highlight', { type: 'geojson', data: activeHighlightGeoJson });
    map.addLayer({
      id: 'route-segment-halo',
      type: 'line',
      source: 'route-segment-highlight',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#ffffff',
        'line-width': 10,
        'line-opacity': 0.9,
      },
    });
    map.addLayer({
      id: 'route-segment-line',
      type: 'line',
      source: 'route-segment-highlight',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': ['coalesce', ['get', 'color'], '#f59e0b'],
        'line-width': 6,
        'line-opacity': 1.0,
      },
    });
  }

  if (map.getLayer('compare-route-line')) {
    if (map.getLayer('route-segment-halo')) {
      map.moveLayer('route-segment-halo');
    }
    if (map.getLayer('route-segment-line')) {
      map.moveLayer('route-segment-line');
    }
  }
}

/** Removes the drawn route but keeps the waypoints. */
function clearRouteLine() {
  activeRouteId = null;
  currentRouteGeoJson = null;
  btnExportGpx.disabled = true;
  updateSegmentHighlight(null);
  hideRouteInfo();
  drawRouteLayer();
  notifyRouterRouteChanged(null);
}

export function getCurrentRoute(): GeoJSON.FeatureCollection | null {
  return currentRouteGeoJson;
}

// ---------------------------------------------------------------------------
// Dragging the route line to add a point
// ---------------------------------------------------------------------------

function projectedDistanceSq(a: number[], lon: number, lat: number): number {
  const dx = (a[0] - lon) * Math.cos((lat * Math.PI) / 180);
  const dy = a[1] - lat;
  return dx * dx + dy * dy;
}

function nearestVertex(coords: number[][], lon: number, lat: number, from = 0): number {
  let best = from;
  let bestDist = Infinity;
  for (let i = from; i < coords.length; i++) {
    const d = projectedDistanceSq(coords[i], lon, lat);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** The leg (waypoint i to i+1) of the current route that is closest to the point. */
function legIndexAt(lon: number, lat: number): number {
  const coords = (currentRouteGeoJson?.features[0]?.geometry as GeoJSON.LineString | undefined)?.coordinates;
  if (!coords) return -1;
  // Position of each waypoint along the line. The search only moves forward.
  const positions: number[] = [];
  let from = 0;
  for (const w of waypoints) {
    from = nearestVertex(coords, w.lon, w.lat, from);
    positions.push(from);
  }
  const at = nearestVertex(coords, lon, lat);
  let leg = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    if (positions[i] <= at) leg = i;
  }
  return leg;
}

function hitsRoute(point: maplibregl.Point): boolean {
  if (!deps.map.getLayer('route-hit')) return false;
  const box: [maplibregl.PointLike, maplibregl.PointLike] = [
    [point.x - ROUTE_HIT_PX, point.y - ROUTE_HIT_PX],
    [point.x + ROUTE_HIT_PX, point.y + ROUTE_HIT_PX],
  ];
  return deps.map.queryRenderedFeatures(box, { layers: ['route-hit'] }).length > 0;
}

let insertDrag: { leg: number; ghost: maplibregl.Marker } | null = null;

function beginInsert(e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) {
  if ('points' in e && e.points.length > 1) return; // Pinch zoom
  if (e.originalEvent instanceof MouseEvent && e.originalEvent.button !== 0) return; // Right click is the menu
  // A marker sits on the line. Pressing it drags the marker.
  if ((e.originalEvent.target as HTMLElement).closest('.wp-marker')) return;
  const leg = legIndexAt(e.lngLat.lng, e.lngLat.lat);
  if (leg < 0) return;
  // Stops the map from panning while the point is dragged.
  e.preventDefault();
  const el = document.createElement('div');
  el.className = 'wp-marker ghost';
  insertDrag = { leg, ghost: new maplibregl.Marker({ element: el }).setLngLat(e.lngLat).addTo(deps.map) };
}

function moveInsert(e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) {
  insertDrag?.ghost.setLngLat(e.lngLat);
}

function finishInsert() {
  if (!insertDrag) return;
  const { leg, ghost } = insertDrag;
  insertDrag = null;
  const { lat, lng } = ghost.getLngLat();
  ghost.remove();
  const next = [...waypoints];
  next.splice(leg + 1, 0, { lat, lon: lng });
  setWaypoints(next);
}

// ---------------------------------------------------------------------------
// GPX export
// ---------------------------------------------------------------------------

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function routeToGpx(geojson: GeoJSON.FeatureCollection, trackName: string): string {
  const feat = geojson.features[0];
  if (!feat || !feat.geometry) {
    return '';
  }

  const props = (feat.properties || {}) as Record<string, any>;
  const lengthM = Number(props['track-length']) || 0;
  const distKm = (lengthM / 1000).toFixed(2);
  const timeMin = Math.round((Number(props['total-time']) || 0) / 60);
  const ascendM = Math.round(Number(props['filtered ascend']) || 0);

  const coords = (feat.geometry as GeoJSON.LineString).coordinates || [];
  const trkpts = coords
    .map(([lon, lat, ele]) => {
      const eleXml =
        ele !== undefined && ele !== null
          ? `\n        <ele>${Number(ele).toFixed(2)}</ele>`
          : '';
      return `      <trkpt lat="${Number(lat).toFixed(6)}" lon="${Number(lon).toFixed(6)}">${eleXml}\n      </trkpt>`;
    })
    .join('\n');

  const escapedName = escapeXml(trackName);

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="rsrouter"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${escapedName}</name>
    <desc>Distance: ${distKm} km, Time: ${timeMin} min, Ascend: ${ascendM} m</desc>
  </metadata>
  <trk>
    <name>${escapedName}</name>
    <desc>Distance: ${distKm} km, Time: ${timeMin} min, Ascend: ${ascendM} m</desc>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
}

function downloadGpxFile(content: string, filename: string) {
  const blob = new Blob([content], { type: 'application/gpx+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoking right away can cancel the download in Safari and Firefox.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

btnExportGpx.addEventListener('click', () => {
  if (!currentRouteGeoJson) return;
  const trackName = `${currentRouteProfile}_route`;
  downloadGpxFile(routeToGpx(currentRouteGeoJson, trackName), `${trackName}.gpx`);
  statusEl.textContent = `Route exported as ${trackName}.gpx`;
});

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function initRoute(d: Deps) {
  deps = d;
  const { map, worker } = d;
  worker.onmessage = handleWorkerMessage;

  initRouteInfo({
    onHover: (position) => {
      if (!position) {
        hoverMarker?.remove();
        hoverMarker = null;
        return;
      }
      if (!hoverMarker) {
        const el = document.createElement('div');
        el.className = 'hover-dot';
        hoverMarker = new maplibregl.Marker({ element: el }).setLngLat([position.lon, position.lat]).addTo(map);
      } else {
        hoverMarker.setLngLat([position.lon, position.lat]);
      }
    },
    onHighlightSegment: (highlight) => {
      updateSegmentHighlight(highlight);
    },
    onAlternative: (index) => {
      if (index === shownAlternative || waypoints.length < 2) return;
      requestedAlternative = index;
      requestRoute();
    },
  });
  onUnitsChange(() => {
    if (currentRouteGeoJson) statusEl.textContent = routeStatus(currentRouteGeoJson);
  });

  // Disable double click zoom so double clicking adds a point cleanly.
  map.doubleClickZoom.disable();

  // Taps that only closed a menu or ended a long press must not add a point.
  let suppressClickUntil = 0;
  let singleClickTimer: ReturnType<typeof setTimeout> | undefined;

  const clearSingleClick = () => {
    if (singleClickTimer) {
      clearTimeout(singleClickTimer);
      singleClickTimer = undefined;
    }
  };

  map.on('click', (e) => {
    if (performance.now() < suppressClickUntil || menuClosedWithin(300)) return;
    if (hitsRoute(e.point)) return; // The line handles its own clicks.
    if ((e.originalEvent as MouseEvent)?.detail > 1) {
      clearSingleClick();
      return;
    }
    clearSingleClick();
    singleClickTimer = setTimeout(() => {
      singleClickTimer = undefined;
      if (performance.now() < suppressClickUntil || menuClosedWithin(300)) return;
      showMapMenu(
        { lat: e.lngLat.lat, lon: e.lngLat.lng },
        e.originalEvent.clientX,
        e.originalEvent.clientY,
      );
    }, 250);
  });

  map.on('dblclick', (e) => {
    clearSingleClick();
    if (performance.now() < suppressClickUntil) return;
    if (hitsRoute(e.point)) return;
    hideMenu();
    setWaypoints([...waypoints, { lat: e.lngLat.lat, lon: e.lngLat.lng }]);
  });

  // Right click on desktop.
  map.on('contextmenu', (e) => {
    clearSingleClick();
    e.originalEvent.preventDefault();
    showMapMenu(
      { lat: e.lngLat.lat, lon: e.lngLat.lng },
      e.originalEvent.clientX,
      e.originalEvent.clientY,
    );
  });

  // Long press on touch screens. iOS does not send a contextmenu event for it.
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelPress = () => clearTimeout(pressTimer);
  map.on('touchstart', (e) => {
    clearSingleClick();
    cancelPress();
    if (e.points.length !== 1 || (e.originalEvent.target as HTMLElement).closest('.wp-marker')) return;
    const touch = e.originalEvent.touches[0];
    pressTimer = setTimeout(() => {
      suppressClickUntil = performance.now() + 500;
      if (insertDrag) {
        insertDrag.ghost.remove();
        insertDrag = null;
      }
      showMapMenu({ lat: e.lngLat.lat, lon: e.lngLat.lng }, touch.clientX, touch.clientY);
    }, LONG_PRESS_MS);
  });
  map.on('touchmove', cancelPress);
  map.on('touchend', cancelPress);
  map.on('touchcancel', cancelPress);
  map.on('movestart', () => {
    clearSingleClick();
    cancelPress();
    hideMenu();
  });

  // Find me: a button on the map that follows the user, and one that sets the start.
  map.addControl(
    new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
      showAccuracyCircle: true,
    }),
    'bottom-right',
  );
  btnMyLocation.addEventListener('click', startFromMyLocation);
  btnShare.addEventListener('click', shareRoute);

  map.on('mousedown', 'route-hit', beginInsert);
  map.on('touchstart', 'route-hit', beginInsert);
  map.on('mousemove', moveInsert);
  map.on('touchmove', moveInsert);
  map.on('mouseup', finishInsert);
  map.on('touchend', finishInsert);
  map.on('mouseenter', 'route-hit', () => (map.getCanvas().style.cursor = 'grab'));
  map.on('mouseleave', 'route-hit', () => (map.getCanvas().style.cursor = ''));

  btnClearRoute.addEventListener('click', () => {
    if (waypoints.length > 0) setWaypoints([]);
  });
  btnUndo.addEventListener('click', undo);
  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    if (target.matches('input, select, textarea')) return;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
    }
  });
  profileSelect.addEventListener('change', () => {
    saveRoute();
    requestedAlternative = 0;
    if (waypoints.length >= 2) requestRoute();
  });

  // A route in the link wins over the one saved from the last visit.
  // If the link has a route that is invalid, start empty rather than show an unrelated route.
  const fromLink = /(?:^#|&)r=/.test(location.hash);
  const initial = fromLink ? parseHash() : loadSavedRoute();
  if (initial) {
    if (initial.profile && [...profileSelect.options].some((o) => o.value === initial.profile)) {
      profileSelect.value = initial.profile;
    }
    setWaypoints(initial.waypoints, false);
    fitToWaypoints();
  } else {
    renderWaypoints();
  }
}
