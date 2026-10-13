import type maplibregl from 'maplibre-gl';
import type { AvoidArea, LatLon } from '../types.ts';
import type { SegmentHighlight } from './classification.ts';
import type { ComparedRoute } from './gpx.ts';
import { createCirclePolygon } from './geo.ts';

const ROUTE_HIT_PX = 8;

export function syncAvoidAreasLayer(map: maplibregl.Map, avoidAreas: AvoidArea[]) {
  const polyData: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: avoidAreas.map((area, index) => ({
      type: 'Feature',
      properties: { index, radius: area.radius },
      geometry: {
        type: 'Polygon',
        coordinates: [createCirclePolygon(area, area.radius)],
      },
    })),
  };

  const centerData: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: avoidAreas.map((area, index) => ({
      type: 'Feature',
      properties: { index },
      geometry: { type: 'Point', coordinates: [area.lon, area.lat] },
    })),
  };

  const polySource = map.getSource('nogo-areas') as maplibregl.GeoJSONSource | undefined;
  if (polySource) {
    polySource.setData(polyData);
  } else {
    map.addSource('nogo-areas', { type: 'geojson', data: polyData });
    map.addLayer({
      id: 'nogo-areas-fill',
      type: 'fill',
      source: 'nogo-areas',
      paint: { 'fill-color': '#ef4444', 'fill-opacity': 0.35 },
    });
    map.addLayer({
      id: 'nogo-areas-stroke',
      type: 'line',
      source: 'nogo-areas',
      paint: { 'line-color': '#dc2626', 'line-width': 2, 'line-dasharray': [2, 2] },
    });
  }

  const centerSource = map.getSource('nogo-areas-center') as maplibregl.GeoJSONSource | undefined;
  if (centerSource) {
    centerSource.setData(centerData);
  } else {
    map.addSource('nogo-areas-center', { type: 'geojson', data: centerData });
    map.addLayer({
      id: 'nogo-areas-center',
      type: 'circle',
      source: 'nogo-areas-center',
      paint: {
        'circle-radius': 5,
        'circle-color': '#dc2626',
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff',
      },
    });
  }
}

export function syncRouteLayer(map: maplibregl.Map, currentRoute: GeoJSON.FeatureCollection | null) {
  const data: GeoJSON.FeatureCollection = currentRoute || {
    type: 'FeatureCollection',
    features: [],
  };

  const source = map.getSource('route') as maplibregl.GeoJSONSource | undefined;
  if (source) {
    source.setData(data);
  } else {
    map.addSource('route', { type: 'geojson', data });
    map.addLayer({
      id: 'route-hit',
      type: 'line',
      source: 'route',
      paint: { 'line-color': '#000000', 'line-width': ROUTE_HIT_PX * 2, 'line-opacity': 0 },
    });
    map.addLayer({
      id: 'route-casing',
      type: 'line',
      source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#38bdf8', 'line-width': 10, 'line-opacity': 0.6 },
    });
    map.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#2563eb', 'line-width': 5, 'line-opacity': 0.95 },
    });
  }
}

export function syncHighlightLayer(map: maplibregl.Map, highlight: SegmentHighlight | null) {
  const data: GeoJSON.FeatureCollection = highlight
    ? {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { color: highlight.color },
            geometry: { type: 'MultiLineString', coordinates: highlight.coordinates },
          },
        ],
      }
    : { type: 'FeatureCollection', features: [] };

  const source = map.getSource('route-segment-highlight') as maplibregl.GeoJSONSource | undefined;
  if (source) {
    source.setData(data);
  } else {
    map.addSource('route-segment-highlight', { type: 'geojson', data });
    map.addLayer({
      id: 'route-segment-halo',
      type: 'line',
      source: 'route-segment-highlight',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 10, 'line-opacity': 0.9 },
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
}

export function syncCompareLayer(map: maplibregl.Map, comparedRoute: ComparedRoute | null) {
  const data: GeoJSON.FeatureCollection = comparedRoute?.geojson || {
    type: 'FeatureCollection',
    features: [],
  };

  const source = map.getSource('compare-route') as maplibregl.GeoJSONSource | undefined;
  if (source) {
    source.setData(data);
    ensureCompareOrder(map);
  } else {
    map.addSource('compare-route', { type: 'geojson', data });
    const beforeId = map.getLayer('route-segment-halo') ? 'route-segment-halo' : undefined;

    map.addLayer(
      {
        id: 'compare-route-casing',
        type: 'line',
        source: 'compare-route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.85 },
      },
      beforeId,
    );
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
    ensureCompareOrder(map);
  }
}

function ensureCompareOrder(map: maplibregl.Map) {
  if (map.getLayer('compare-route-casing')) {
    if (map.getLayer('compare-route-line')) map.moveLayer('compare-route-line');
    if (map.getLayer('route-segment-halo')) map.moveLayer('route-segment-halo');
    if (map.getLayer('route-segment-line')) map.moveLayer('route-segment-line');
  }
}

export function getRouteBoundsPadding(): maplibregl.PaddingOptions {
  const isMobile = window.innerWidth <= 640;
  if (isMobile) {
    const controlsEl = document.getElementById('controls');
    const isControlsExpanded = controlsEl && !controlsEl.classList.contains('collapsed');
    const topPad = isControlsExpanded ? 240 : 70;
    const drawerEl = document.getElementById('elevation-drawer');
    const isDrawerOpen = drawerEl && !drawerEl.classList.contains('collapsed') && !drawerEl.hidden;
    const bottomPad = isDrawerOpen ? 200 : 120;
    return { top: topPad, bottom: bottomPad, left: 24, right: 24 };
  } else {
    const controlsEl = document.getElementById('controls');
    const isControlsCollapsed = controlsEl?.classList.contains('collapsed');
    const leftPad = isControlsCollapsed ? 80 : 420;
    const drawerEl = document.getElementById('elevation-drawer');
    const isDrawerOpen = drawerEl && !drawerEl.classList.contains('collapsed') && !drawerEl.hidden;
    const bottomPad = isDrawerOpen ? 220 : 80;
    return { top: 60, bottom: bottomPad, left: leftPad, right: 60 };
  }
}

export function fitRouteBounds(
  map: maplibregl.Map,
  route: GeoJSON.FeatureCollection | null,
  waypoints: LatLon[],
  animate = true,
) {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let count = 0;

  if (route && route.features) {
    for (const feat of route.features) {
      if (feat.geometry && feat.geometry.type === 'LineString') {
        const coords = (feat.geometry as GeoJSON.LineString).coordinates;
        for (const [lon, lat] of coords) {
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          count++;
        }
      }
    }
  }

  if (count === 0 && waypoints.length > 0) {
    for (const wp of waypoints) {
      if (wp.lon < minLon) minLon = wp.lon;
      if (wp.lon > maxLon) maxLon = wp.lon;
      if (wp.lat < minLat) minLat = wp.lat;
      if (wp.lat > maxLat) maxLat = wp.lat;
      count++;
    }
  }

  if (count === 0) return;

  if (minLon === maxLon && minLat === maxLat) {
    map.flyTo({
      center: [minLon, minLat],
      zoom: 14,
      duration: animate ? 600 : 0,
    });
    return;
  }

  const padding = getRouteBoundsPadding();
  map.fitBounds(
    [
      [minLon, minLat],
      [maxLon, maxLat],
    ],
    {
      padding,
      maxZoom: 16,
      duration: animate ? 600 : 0,
    },
  );
}
