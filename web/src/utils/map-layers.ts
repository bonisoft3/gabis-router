import type maplibregl from 'maplibre-gl';
import {
  MAX_ROUTE_SLOTS,
  ROUTE_SLOT_COLORS,
  type AvoidArea,
  type LatLon,
  type RouteSlotState,
} from '../types.ts';
import type { SegmentHighlight } from './classification.ts';
import { createCirclePolygon } from './geo.ts';

const ROUTE_HIT_PX = 8;

const EMPTY_FC: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
};

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

export function syncRoutesLayers(map: maplibregl.Map, slots: RouteSlotState[]) {
  const hitFeatures: GeoJSON.Feature[] = [];

  // Create/update sources and layers in reverse slot order (2 -> 1 -> 0) so slot 0 renders on top
  for (let slotIdx = MAX_ROUTE_SLOTS - 1; slotIdx >= 0; slotIdx--) {
    const slot = slots[slotIdx];
    const data: GeoJSON.FeatureCollection = slot?.route || EMPTY_FC;
    if (slot?.route?.features) {
      hitFeatures.push(...slot.route.features);
    }

    const sourceId = slotIdx === 0 ? 'route' : `route-${slotIdx}`;
    const haloId = slotIdx === 0 ? 'route-halo' : `route-${slotIdx}-halo`;
    const casingId = slotIdx === 0 ? 'route-casing' : `route-${slotIdx}-casing`;
    const lineId = slotIdx === 0 ? 'route-line' : `route-${slotIdx}-line`;
    const color = ROUTE_SLOT_COLORS[slotIdx] || ROUTE_SLOT_COLORS[0];

    const source = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
    if (source) {
      source.setData(data);
    } else {
      map.addSource(sourceId, { type: 'geojson', data });
      map.addLayer({
        id: haloId,
        type: 'line',
        source: sourceId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.92 },
      });
      map.addLayer({
        id: casingId,
        type: 'line',
        source: sourceId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': color.casing, 'line-width': 6.5, 'line-opacity': 0.9 },
      });
      map.addLayer({
        id: lineId,
        type: 'line',
        source: sourceId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': color.line, 'line-width': 4.5, 'line-opacity': 1 },
      });
    }
  }

  const hitData: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: hitFeatures,
  };
  const hitSource = map.getSource('route-hit-src') as maplibregl.GeoJSONSource | undefined;
  if (hitSource) {
    hitSource.setData(hitData);
  } else {
    map.addSource('route-hit-src', { type: 'geojson', data: hitData });
    map.addLayer({
      id: 'route-hit',
      type: 'line',
      source: 'route-hit-src',
      paint: { 'line-color': '#000000', 'line-width': ROUTE_HIT_PX * 2.5, 'line-opacity': 0 },
    });
  }

  ensureRouteLayerOrder(map);
}

function ensureRouteLayerOrder(map: maplibregl.Map) {
  const orderedIds = [
    'route-2-halo',
    'route-2-casing',
    'route-2-line',
    'route-1-halo',
    'route-1-casing',
    'route-1-line',
    'route-halo',
    'route-casing',
    'route-line',
    'route-hit',
    'route-segment-halo',
    'route-segment-line',
  ];
  for (const id of orderedIds) {
    if (map.getLayer(id)) {
      map.moveLayer(id);
    }
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
    : EMPTY_FC;

  const source = map.getSource('route-segment-highlight') as maplibregl.GeoJSONSource | undefined;
  if (source) {
    source.setData(data);
    if (highlight && highlight.coordinates.length > 0) {
      if (map.getLayer('route-segment-halo')) map.moveLayer('route-segment-halo');
      if (map.getLayer('route-segment-line')) map.moveLayer('route-segment-line');
    }
  } else {
    map.addSource('route-segment-highlight', { type: 'geojson', data });
    map.addLayer({
      id: 'route-segment-halo',
      type: 'line',
      source: 'route-segment-highlight',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 11, 'line-opacity': 0.95 },
    });
    map.addLayer({
      id: 'route-segment-line',
      type: 'line',
      source: 'route-segment-highlight',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': ['coalesce', ['get', 'color'], '#f59e0b'],
        'line-width': 6.5,
        'line-opacity': 1.0,
      },
    });
  }
}

export function getRouteBoundsPadding(): maplibregl.PaddingOptions {
  const rootEl = document.getElementById('root');
  const vw = rootEl?.clientWidth || window.innerWidth;
  const vh = rootEl?.clientHeight || window.innerHeight;
  const isMobile = vw <= 860;
  const controlsEl = document.getElementById('controls');
  const drawerEl = document.getElementById('route-info');

  if (isMobile) {
    const isControlsExpanded = controlsEl && !controlsEl.classList.contains('collapsed');
    const topPad = isControlsExpanded ? Math.min(260, (controlsEl?.offsetHeight || 200) + 24) : 72;
    const isDrawerVisible = drawerEl && !drawerEl.hidden;
    const isDrawerExpanded = isDrawerVisible && !drawerEl.classList.contains('collapsed');
    const bottomPad = isDrawerExpanded
      ? Math.min(Math.round(vh * 0.65), (drawerEl?.offsetHeight || 220) + 24)
      : isDrawerVisible
      ? Math.min(220, (drawerEl?.offsetHeight || 72) + 24)
      : 48;
    return { top: topPad, bottom: bottomPad, left: 28, right: 28 };
  } else {
    const isControlsCollapsed = controlsEl?.classList.contains('collapsed');
    const leftPad = isControlsCollapsed ? 64 : (controlsEl?.offsetWidth || 368) + 48;
    const isDrawerVisible = drawerEl && !drawerEl.hidden;
    const isDrawerExpanded = isDrawerVisible && !drawerEl.classList.contains('collapsed');
    const bottomPad = isDrawerExpanded
      ? Math.min(Math.round(vh * 0.72), (drawerEl?.offsetHeight || 240) + 28)
      : isDrawerVisible
      ? Math.min(240, (drawerEl?.offsetHeight || 76) + 28)
      : 56;
    return { top: 44, bottom: bottomPad, left: leftPad, right: 64 };
  }
}

export function fitRouteBounds(
  map: maplibregl.Map,
  slots: RouteSlotState[],
  waypoints: LatLon[],
  animate = true,
) {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let count = 0;

  for (const slot of slots) {
    const route = slot.route;
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

  const shouldAnimate = animate && (typeof document === 'undefined' || !document.hidden);

  if (minLon === maxLon && minLat === maxLat) {
    map.flyTo({
      center: [minLon, minLat],
      zoom: 14,
      duration: shouldAnimate ? 600 : 0,
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
      duration: shouldAnimate ? 600 : 0,
    },
  );
}
