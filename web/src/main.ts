import maplibregl from 'maplibre-gl';
import type { LatLon, ProfileName, WorkerMessage } from './types.ts';

const statusEl = document.getElementById('status')!;
const profileSelect = document.getElementById('profile-select') as HTMLSelectElement;

// Initialize MapLibre GL JS with OpenFreeMap vector tiles (free, no API key required)
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [-0.1276, 51.5074], // London
  zoom: 11,
});

map.addControl(new maplibregl.NavigationControl(), 'top-right');

// Web Worker for off-thread routing
const worker = new Worker(new URL('./worker.ts', import.meta.url), {
  type: 'module',
});

worker.postMessage({ type: 'INIT', payload: { segmentUrls: [] } });

worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'STATUS':
      statusEl.textContent = msg.message;
      break;
    case 'ROUTE_SUCCESS': {
      statusEl.textContent = 'Route calculated successfully.';
      renderRoute(msg.payload);
      break;
    }
    case 'ROUTE_ERROR':
      statusEl.textContent = `Routing error: ${msg.error}`;
      break;
  }
};

let waypoints: LatLon[] = [];
let markers: maplibregl.Marker[] = [];

map.on('click', (e) => {
  if (waypoints.length >= 2) {
    // Reset markers on 3rd click
    markers.forEach((m) => m.remove());
    markers = [];
    waypoints = [];
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

function renderRoute(geojson: GeoJSON.FeatureCollection) {
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
  const source = map.getSource('route') as maplibregl.GeoJSONSource | undefined;
  if (source) {
    source.setData({
      type: 'FeatureCollection',
      features: [],
    });
  }
}

// Register service worker for offline PWA support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}
