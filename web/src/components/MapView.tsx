import React, { useEffect, useRef, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as pmtiles from 'pmtiles';
import type { AvoidArea, LatLon } from '../types.ts';
import type { Basemap } from '../basemap.ts';
import type { SegmentHighlight } from '../utils/classification.ts';
import type { ComparedRoute } from '../utils/gpx.ts';
import { getOfflineStyle, getOnlineStyle, UK_CENTER, UK_BOUNDS } from '../utils/map-styles.ts';
import { tilePickerControl } from '../tile-picker.ts';
import { centerRouteControl } from '../center-control.ts';
import { loadedPMTiles } from '../hooks/useOffline.ts';
import { MAP_TILES_CACHE_NAME } from '../segment-cache.ts';
import { showMenu, hideMenu, menuClosedWithin } from '../menu.ts';
import { distanceMeters, nearestVertex } from '../utils/geo.ts';
import {
  syncAvoidAreasLayer,
  syncRouteLayer,
  syncHighlightLayer,
  syncCompareLayer,
  fitRouteBounds,
} from '../utils/map-layers.ts';

// Register PMTiles protocols once globally
let protocolsRegistered = false;
function registerProtocols() {
  if (protocolsRegistered) return;
  protocolsRegistered = true;

  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);

  maplibregl.addProtocol('pmtiles-composite', async (params) => {
    const match = params.url.match(/pmtiles-composite:\/\/(\d+)\/(\d+)\/(\d+)\.pbf/);
    if (!match) return { data: new Uint8Array(0) };
    const z = parseInt(match[1], 10);
    const x = parseInt(match[2], 10);
    const y = parseInt(match[3], 10);

    for (const p of loadedPMTiles.values()) {
      const tile = await p.getZxy(z, x, y);
      if (tile && tile.data) {
        return { data: tile.data };
      }
    }
    return { data: new Uint8Array(0) };
  });

  maplibregl.addProtocol('offline-tile', async (params, abortController) => {
    const originalUrl = params.url.replace(/^offline-tile:\/\//, 'https://');
    const cache = await caches.open(MAP_TILES_CACHE_NAME);
    const cached = await cache.match(originalUrl);
    if (cached) return { data: await cached.arrayBuffer() };

    const isOffline = localStorage.getItem('rsrouter_offline_mode') === 'true';
    if (isOffline) return { data: new ArrayBuffer(0) };

    try {
      const res = await fetch(originalUrl, { signal: abortController.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await cache.put(originalUrl, res.clone());
      return { data: await res.arrayBuffer() };
    } catch {
      return { data: new ArrayBuffer(0) };
    }
  });
}

function waypointKind(i: number, n: number): 'start' | 'end' | 'via' {
  if (i === 0) return 'start';
  return i === n - 1 ? 'end' : 'via';
}

function waypointLabel(i: number, n: number): string {
  const kind = waypointKind(i, n);
  return kind === 'start' ? 'A' : kind === 'end' ? 'B' : String(i);
}

const DEFAULT_AVOID_RADIUS_M = 30;
const LONG_PRESS_MS = 600;
const DRAG_THRESHOLD_PX = 8;

interface MapViewProps {
  waypoints: LatLon[];
  avoidAreas: AvoidArea[];
  currentRoute: GeoJSON.FeatureCollection | null;
  comparedRoute: ComparedRoute | null;
  segmentHighlight: SegmentHighlight | null;
  hoverPosition: { lat: number; lon: number } | null;
  isOfflineMode: boolean;
  basemap: Basemap;
  thunderforestKey: string;
  onAddWaypoint: (point: LatLon, action?: 'start' | 'end' | 'via' | 'append') => void;
  onInsertWaypointAtLeg?: (point: LatLon, index: number) => void;
  onMoveWaypoint: (index: number, point: LatLon) => void;
  onRemoveWaypoint: (index: number) => void;
  onRenameWaypoint: (index: number, name: string) => void;
  onAddAvoidArea: (area: LatLon, radius?: number) => void;
  onRemoveAvoidArea: (index: number) => void;
  onStatusChange: (status: string) => void;
  onMapInstance?: (map: maplibregl.Map) => void;
}

export const MapView: React.FC<MapViewProps> = ({
  waypoints,
  avoidAreas,
  currentRoute,
  comparedRoute,
  segmentHighlight,
  hoverPosition,
  isOfflineMode,
  basemap,
  thunderforestKey,
  onAddWaypoint,
  onInsertWaypointAtLeg,
  onMoveWaypoint,
  onRemoveWaypoint,
  onRenameWaypoint,
  onAddAvoidArea,
  onRemoveAvoidArea,
  onStatusChange,
  onMapInstance,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const styleReadyRef = useRef<boolean>(false);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const hoverMarkerRef = useRef<maplibregl.Marker | null>(null);

  const waypointsRef = useRef(waypoints);
  waypointsRef.current = waypoints;
  const avoidAreasRef = useRef(avoidAreas);
  avoidAreasRef.current = avoidAreas;
  const currentRouteRef = useRef(currentRoute);
  currentRouteRef.current = currentRoute;

  const insertDragRef = useRef<{
    leg: number;
    startPoint: { x: number; y: number };
    ghost: maplibregl.Marker | null;
    hasDragged: boolean;
  } | null>(null);

  const suppressClickUntilRef = useRef<number>(0);

  const drawAllLayers = useCallback(() => {
    const map = mapRef.current;
    if (!map || !styleReadyRef.current) return;
    syncAvoidAreasLayer(map, avoidAreasRef.current);
    syncRouteLayer(map, currentRouteRef.current);
    syncHighlightLayer(map, segmentHighlight);
    syncCompareLayer(map, comparedRoute);
  }, [segmentHighlight, comparedRoute]);

  // Map initialization
  useEffect(() => {
    if (!containerRef.current) return;
    registerProtocols();

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: isOfflineMode ? getOfflineStyle() : getOnlineStyle(basemap, thunderforestKey),
      center: UK_CENTER,
      zoom: 6,
      maxBounds: isOfflineMode ? UK_BOUNDS : undefined,
      attributionControl: false,
    });
    mapRef.current = map;
    (window as any).map = map;

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
        showAccuracyCircle: true,
      }),
      'top-right',
    );
    map.addControl(tilePickerControl, 'top-right');
    map.addControl(centerRouteControl, 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-right');

    centerRouteControl.setOnCenter(() => {
      const currentMap = mapRef.current;
      if (!currentMap) return;
      fitRouteBounds(currentMap, currentRouteRef.current, waypointsRef.current, true);
    });

    onMapInstance?.(map);

    map.on('style.load', () => {
      styleReadyRef.current = true;
      drawAllLayers();
      if (currentRouteRef.current) {
        fitRouteBounds(map, currentRouteRef.current, waypointsRef.current, false);
      }
    });

    map.on('error', (e) => {
      const err = e.error;
      const msg = (err && (err.message || String(err))) || '';
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (/signal is aborted/i.test(msg) || /aborted/i.test(msg)) return;
      if (err && typeof err === 'object' && ('status' in err || /403|401|404/i.test(msg))) return;
      console.warn('[Map notice]', err);
    });

    map.on('styleimagemissing', (e) => {
      if (!map.hasImage(e.id)) {
        map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
      }
    });

    // Gesture & Click handling
    let singleClickTimer: ReturnType<typeof setTimeout> | undefined;
    const clearSingleClick = () => {
      if (singleClickTimer) {
        clearTimeout(singleClickTimer);
        singleClickTimer = undefined;
      }
    };

    const findAvoidAreaAt = (p: LatLon, screenPoint?: { x: number; y: number }): number => {
      const currentAvoids = avoidAreasRef.current;
      if (screenPoint) {
        for (let i = currentAvoids.length - 1; i >= 0; i--) {
          const pt = map.project([currentAvoids[i].lon, currentAvoids[i].lat]);
          if (Math.hypot(pt.x - screenPoint.x, pt.y - screenPoint.y) <= 12) return i;
        }
      }
      for (let i = currentAvoids.length - 1; i >= 0; i--) {
        if (distanceMeters(p, currentAvoids[i]) <= Math.max(currentAvoids[i].radius, 15)) return i;
      }
      return -1;
    };

    const showMapContextMenu = (p: LatLon, x: number, y: number) => {
      showMenu(
        [
          { label: 'Add point', onSelect: () => onAddWaypoint(p) },
          { label: 'Start here', onSelect: () => onAddWaypoint(p, 'start') },
          { label: 'Via here', onSelect: () => onAddWaypoint(p, 'via') },
          { label: 'End here', onSelect: () => onAddWaypoint(p, 'end') },
          { label: 'Avoid here', onSelect: () => onAddAvoidArea(p, DEFAULT_AVOID_RADIUS_M) },
          {
            label: 'See on Google Street View',
            onSelect: () => {
              window.open(
                `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p.lat.toFixed(6)},${p.lon.toFixed(6)}`,
                '_blank',
                'noopener,noreferrer',
              );
            },
          },
          {
            label: 'Copy coordinates',
            onSelect: async () => {
              const text = `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
              await navigator.clipboard.writeText(text);
              onStatusChange(`Copied ${text}`);
            },
          },
        ],
        x,
        y,
      );
    };

    const showAvoidContextMenu = (index: number, x: number, y: number) => {
      const area = avoidAreasRef.current[index];
      if (!area) return;
      showMenu(
        [
          { label: 'Remove avoid area', onSelect: () => onRemoveAvoidArea(index) },
          {
            label: 'See on Google Street View',
            onSelect: () => {
              window.open(
                `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${area.lat.toFixed(6)},${area.lon.toFixed(6)}`,
                '_blank',
                'noopener,noreferrer',
              );
            },
          },
          {
            label: 'Copy coordinates',
            onSelect: async () => {
              const text = `${area.lat.toFixed(5)}, ${area.lon.toFixed(5)}`;
              await navigator.clipboard.writeText(text);
              onStatusChange(`Copied ${text}`);
            },
          },
        ],
        x,
        y,
      );
    };

    map.on('click', (e) => {
      if (performance.now() < suppressClickUntilRef.current || menuClosedWithin(300)) return;
      clearSingleClick();
      singleClickTimer = setTimeout(() => {
        singleClickTimer = undefined;
        if (performance.now() < suppressClickUntilRef.current || menuClosedWithin(300)) return;
        const p = { lat: e.lngLat.lat, lon: e.lngLat.lng };
        const avoidIdx = findAvoidAreaAt(p, e.point);
        if (avoidIdx !== -1) {
          showAvoidContextMenu(avoidIdx, e.originalEvent.clientX, e.originalEvent.clientY);
        } else {
          showMapContextMenu(p, e.originalEvent.clientX, e.originalEvent.clientY);
        }
      }, 250);
    });

    map.on('dblclick', () => {
      clearSingleClick();
      hideMenu();
    });

    map.on('contextmenu', (e) => {
      clearSingleClick();
      e.originalEvent.preventDefault();
      const p = { lat: e.lngLat.lat, lon: e.lngLat.lng };
      const avoidIdx = findAvoidAreaAt(p, e.point);
      if (avoidIdx !== -1) {
        showAvoidContextMenu(avoidIdx, e.originalEvent.clientX, e.originalEvent.clientY);
      } else {
        showMapContextMenu(p, e.originalEvent.clientX, e.originalEvent.clientY);
      }
    });

    // Touch long-press
    let pressTimer: ReturnType<typeof setTimeout> | undefined;
    map.on('touchstart', (e) => {
      clearSingleClick();
      clearTimeout(pressTimer);
      if (e.points.length > 1 || (e.originalEvent.touches && e.originalEvent.touches.length > 1)) {
        suppressClickUntilRef.current = performance.now() + 600;
        return;
      }
      if ((e.originalEvent.target as HTMLElement).closest('.wp-marker')) return;
      const touch = e.originalEvent.touches[0];
      pressTimer = setTimeout(() => {
        suppressClickUntilRef.current = performance.now() + 500;
        const p = { lat: e.lngLat.lat, lon: e.lngLat.lng };
        const avoidIdx = findAvoidAreaAt(p, e.point);
        if (avoidIdx !== -1) {
          showAvoidContextMenu(avoidIdx, touch.clientX, touch.clientY);
        } else {
          showMapContextMenu(p, touch.clientX, touch.clientY);
        }
      }, LONG_PRESS_MS);
    });

    map.on('touchmove', () => clearTimeout(pressTimer));
    map.on('touchend', () => clearTimeout(pressTimer));
    map.on('touchcancel', () => clearTimeout(pressTimer));

    // Route dragging insert logic
    const legIndexAt = (lon: number, lat: number): number => {
      const coords = (currentRouteRef.current?.features[0]?.geometry as GeoJSON.LineString | undefined)?.coordinates;
      if (!coords) return -1;
      const positions: number[] = [];
      let from = 0;
      for (const w of waypointsRef.current) {
        from = nearestVertex(coords, w.lon, w.lat, from);
        positions.push(from);
      }
      const at = nearestVertex(coords, lon, lat);
      let leg = 0;
      for (let i = 0; i < waypointsRef.current.length - 1; i++) {
        if (positions[i] <= at) leg = i;
      }
      return leg;
    };

    const beginInsert = (e: maplibregl.MapMouseEvent) => {
      const orig = e.originalEvent;
      if ('touches' in orig || (window.TouchEvent && orig instanceof TouchEvent)) return;
      if (orig instanceof PointerEvent && orig.pointerType === 'touch') return;
      if (orig instanceof MouseEvent && orig.button !== 0) return;
      if ((orig.target as HTMLElement)?.closest('.wp-marker')) return;
      const leg = legIndexAt(e.lngLat.lng, e.lngLat.lat);
      if (leg < 0) return;
      e.preventDefault();
      insertDragRef.current = {
        leg,
        startPoint: { x: e.point.x, y: e.point.y },
        ghost: null,
        hasDragged: false,
      };
    };

    const moveInsert = (e: maplibregl.MapMouseEvent) => {
      const drag = insertDragRef.current;
      if (!drag) return;
      if (!drag.hasDragged) {
        const dx = e.point.x - drag.startPoint.x;
        const dy = e.point.y - drag.startPoint.y;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        drag.hasDragged = true;
        map.getCanvas().style.cursor = 'grabbing';
        const el = document.createElement('div');
        el.className = 'wp-marker ghost';
        drag.ghost = new maplibregl.Marker({ element: el }).setLngLat(e.lngLat).addTo(map);
        return;
      }
      drag.ghost?.setLngLat(e.lngLat);
    };

    const finishInsert = () => {
      const drag = insertDragRef.current;
      if (!drag) return;
      drag.ghost?.remove();
      insertDragRef.current = null;
      map.getCanvas().style.cursor = '';
      if (!drag.hasDragged || !drag.ghost) return;
      suppressClickUntilRef.current = performance.now() + 400;
      const { lat, lng } = drag.ghost.getLngLat();
      if (onInsertWaypointAtLeg) {
        onInsertWaypointAtLeg({ lat, lon: lng }, drag.leg + 1);
      } else {
        onAddWaypoint({ lat, lon: lng }, 'via');
      }
    };

    map.on('mousedown', 'route-hit', beginInsert);
    map.on('mousemove', moveInsert);
    map.on('mouseup', finishInsert);
    map.on('mouseenter', 'route-hit', () => (map.getCanvas().style.cursor = 'grab'));
    map.on('mouseleave', 'route-hit', () => {
      if (!insertDragRef.current?.hasDragged) map.getCanvas().style.cursor = '';
    });
    map.on('mouseenter', 'nogo-areas-fill', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'nogo-areas-fill', () => (map.getCanvas().style.cursor = ''));
    map.on('mouseenter', 'nogo-areas-center', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'nogo-areas-center', () => (map.getCanvas().style.cursor = ''));

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []); // Run once on mount

  // Sync layers when props change
  useEffect(() => {
    if (mapRef.current && styleReadyRef.current) {
      syncAvoidAreasLayer(mapRef.current, avoidAreas);
    }
  }, [avoidAreas]);

  const prevRouteRef = useRef<GeoJSON.FeatureCollection | null>(null);

  useEffect(() => {
    if (mapRef.current && styleReadyRef.current) {
      syncRouteLayer(mapRef.current, currentRoute);
      if (currentRoute && currentRoute !== prevRouteRef.current) {
        fitRouteBounds(mapRef.current, currentRoute, waypointsRef.current, true);
      }
      prevRouteRef.current = currentRoute;
    }
  }, [currentRoute]);

  useEffect(() => {
    const canCenter = waypoints.length > 0 || !!(currentRoute && currentRoute.features?.length);
    centerRouteControl.setEnabled(canCenter);
  }, [waypoints, currentRoute]);

  useEffect(() => {
    if (mapRef.current && styleReadyRef.current) {
      syncCompareLayer(mapRef.current, comparedRoute);
    }
  }, [comparedRoute]);

  useEffect(() => {
    if (mapRef.current && styleReadyRef.current) {
      syncHighlightLayer(mapRef.current, segmentHighlight);
    }
  }, [segmentHighlight]);

  // Update styles when basemap/offline mode changes
  const prevStylePropsRef = useRef({ isOfflineMode, basemap, thunderforestKey });
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const prev = prevStylePropsRef.current;
    if (
      prev.isOfflineMode === isOfflineMode &&
      prev.basemap === basemap &&
      prev.thunderforestKey === thunderforestKey
    ) {
      return;
    }
    prevStylePropsRef.current = { isOfflineMode, basemap, thunderforestKey };

    styleReadyRef.current = false;
    map.setMaxBounds(isOfflineMode ? UK_BOUNDS : null);
    tilePickerControl.setOffline(isOfflineMode);
    map.setStyle(
      isOfflineMode ? getOfflineStyle() : getOnlineStyle(basemap, thunderforestKey),
      { diff: false },
    );
  }, [isOfflineMode, basemap, thunderforestKey]);

  // Waypoint markers synchronization
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    markersRef.current.forEach((m) => m.remove());
    const n = waypoints.length;

    markersRef.current = waypoints.map((w, index) => {
      const el = document.createElement('div');
      el.className = `wp-marker ${waypointKind(index, n)}`;
      el.textContent = waypointLabel(index, n);
      el.title = w.name
        ? `${waypointLabel(index, n)}: ${w.name}`
        : `${waypointLabel(index, n)}: ${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}`;

      let wasDragged = false;
      const marker = new maplibregl.Marker({ element: el, draggable: true, clickTolerance: 4 })
        .setLngLat([w.lon, w.lat])
        .addTo(map);

      marker.on('dragstart', () => {
        wasDragged = true;
        hideMenu();
      });

      marker.on('dragend', () => {
        const { lat, lng } = marker.getLngLat();
        onMoveWaypoint(index, { lat, lon: lng });
        setTimeout(() => {
          wasDragged = false;
        }, 150);
      });

      const showMarkerContextMenu = (e: MouseEvent) => {
        showMenu(
          [
            {
              label: 'Rename point',
              onSelect: () => {
                const currentName = waypointsRef.current[index]?.name || '';
                const nextName = window.prompt('Rename point:', currentName);
                if (nextName !== null) {
                  onRenameWaypoint(index, nextName);
                }
              },
            },
            {
              label: 'Remove point',
              onSelect: () => onRemoveWaypoint(index),
            },
            {
              label: 'See on Google Street View',
              onSelect: () => {
                window.open(
                  `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${w.lat.toFixed(6)},${w.lon.toFixed(6)}`,
                  '_blank',
                  'noopener,noreferrer',
                );
              },
            },
            {
              label: 'Copy coordinates',
              onSelect: async () => {
                const text = `${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}`;
                await navigator.clipboard.writeText(text);
                onStatusChange(`Copied ${text}`);
              },
            },
          ],
          e.clientX,
          e.clientY,
        );
      };

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (wasDragged) return;
        showMarkerContextMenu(e);
      });

      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showMarkerContextMenu(e);
      });

      return marker;
    });
  }, [waypoints, onMoveWaypoint, onRemoveWaypoint, onRenameWaypoint, onStatusChange]);

  // Hover marker
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!hoverPosition) {
      hoverMarkerRef.current?.remove();
      hoverMarkerRef.current = null;
      return;
    }
    if (!hoverMarkerRef.current) {
      const el = document.createElement('div');
      el.className = 'hover-dot';
      hoverMarkerRef.current = new maplibregl.Marker({ element: el })
        .setLngLat([hoverPosition.lon, hoverPosition.lat])
        .addTo(map);
    } else {
      hoverMarkerRef.current.setLngLat([hoverPosition.lon, hoverPosition.lat]);
    }
  }, [hoverPosition]);

  return <div id="map" ref={containerRef} />;
};
