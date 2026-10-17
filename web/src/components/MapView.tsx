import React, { useEffect, useRef, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as pmtiles from 'pmtiles';
import { DEFAULT_AVOID_RADIUS_M } from '../hooks/useRouting.ts';
import {
  AVOID_RADIUS_PRESETS,
  waypointKind,
  waypointLabel,
  type AvoidArea,
  type LatLon,
  type RouteSlotState,
} from '../types.ts';
import type { Basemap } from '../basemap.ts';
import type { SegmentHighlight } from '../utils/classification.ts';
import { getOfflineStyle, getOnlineStyle, UK_CENTER, UK_BOUNDS } from '../utils/map-styles.ts';
import { tilePickerControl } from '../tile-picker.ts';
import { centerRouteControl } from '../center-control.ts';
import { loadedPMTiles, archivesReady } from '../hooks/useOffline.ts';
import { MAP_TILES_CACHE_NAME } from '../segment-cache.ts';
import { showMenu, hideMenu, menuClosedWithin, type MenuItem } from '../menu.ts';
import { distanceMeters, legIndexAt, nearestVertex } from '../utils/geo.ts';
import {
  syncAvoidAreasLayer,
  syncRoutesLayers,
  syncHighlightLayer,
  fitRouteBounds,
} from '../utils/map-layers.ts';

// Register PMTiles protocols once globally
function registerProtocols() {
  if ((window as any).__rsrouterProtocolsRegistered) return;
  (window as any).__rsrouterProtocolsRegistered = true;

  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);

  maplibregl.addProtocol('pmtiles-composite', async (params) => {
    const match = params.url.match(/pmtiles-composite:\/\/(\d+)\/(\d+)\/(\d+)\.pbf/);
    if (!match) return { data: new Uint8Array(0) };
    const z = parseInt(match[1], 10);
    const x = parseInt(match[2], 10);
    const y = parseInt(match[3], 10);

    await archivesReady;

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

const LONG_PRESS_MS = 550;
const DRAG_THRESHOLD_PX = 8;

interface MapViewProps {
  waypoints: LatLon[];
  avoidAreas: AvoidArea[];
  slots: RouteSlotState[];
  segmentHighlight: SegmentHighlight | null;
  hoverPosition: { lat: number; lon: number } | null;
  isOfflineMode: boolean;
  basemap: Basemap;
  thunderforestKey: string;
  fitBoundsSeq: number;
  onAddWaypoint: (point: LatLon, action?: 'start' | 'end' | 'via' | 'append') => void;
  onInsertWaypointAtLeg: (point: LatLon, index: number) => void;
  onMoveWaypoint: (index: number, point: LatLon) => void;
  onRemoveWaypoint: (index: number) => void;
  onRenameWaypoint: (index: number, name: string) => void;
  onRequestInlineRename?: (index: number) => void;
  onAddAvoidArea: (area: LatLon, radius?: number) => void;
  onUpdateAvoidAreaRadius: (index: number, radius: number) => void;
  onRemoveAvoidArea: (index: number) => void;
  onHoverPosition?: (pos: { lat: number; lon: number } | null) => void;
  onStatusChange: (status: string) => void;
  onMapInstance?: (map: maplibregl.Map) => void;
}

export const MapView: React.FC<MapViewProps> = ({
  waypoints,
  avoidAreas,
  slots,
  segmentHighlight,
  hoverPosition,
  isOfflineMode,
  basemap,
  thunderforestKey,
  fitBoundsSeq,
  onAddWaypoint,
  onInsertWaypointAtLeg,
  onMoveWaypoint,
  onRemoveWaypoint,
  onRenameWaypoint,
  onRequestInlineRename,
  onAddAvoidArea,
  onUpdateAvoidAreaRadius,
  onRemoveAvoidArea,
  onHoverPosition,
  onStatusChange,
  onMapInstance,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const styleReadyRef = useRef<boolean>(false);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const hoverMarkerRef = useRef<maplibregl.Marker | null>(null);
  const draggingMarkerIndexRef = useRef<number | null>(null);
  const lastOpenedMarkerIndexRef = useRef<number | null>(null);

  const waypointsRef = useRef(waypoints);
  waypointsRef.current = waypoints;
  const avoidAreasRef = useRef(avoidAreas);
  avoidAreasRef.current = avoidAreas;
  const slotsRef = useRef(slots);
  slotsRef.current = slots;

  const onAddWaypointRef = useRef(onAddWaypoint);
  onAddWaypointRef.current = onAddWaypoint;
  const onInsertWaypointAtLegRef = useRef(onInsertWaypointAtLeg);
  onInsertWaypointAtLegRef.current = onInsertWaypointAtLeg;
  const onMoveWaypointRef = useRef(onMoveWaypoint);
  onMoveWaypointRef.current = onMoveWaypoint;
  const onRemoveWaypointRef = useRef(onRemoveWaypoint);
  onRemoveWaypointRef.current = onRemoveWaypoint;
  const onRenameWaypointRef = useRef(onRenameWaypoint);
  onRenameWaypointRef.current = onRenameWaypoint;
  const onRequestInlineRenameRef = useRef(onRequestInlineRename);
  onRequestInlineRenameRef.current = onRequestInlineRename;
  const onAddAvoidAreaRef = useRef(onAddAvoidArea);
  onAddAvoidAreaRef.current = onAddAvoidArea;
  const onUpdateAvoidAreaRadiusRef = useRef(onUpdateAvoidAreaRadius);
  onUpdateAvoidAreaRadiusRef.current = onUpdateAvoidAreaRadius;
  const onRemoveAvoidAreaRef = useRef(onRemoveAvoidArea);
  onRemoveAvoidAreaRef.current = onRemoveAvoidArea;
  const onHoverPositionRef = useRef(onHoverPosition);
  onHoverPositionRef.current = onHoverPosition;
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  const onMapInstanceRef = useRef(onMapInstance);
  onMapInstanceRef.current = onMapInstance;

  const pendingFitRouteRef = useRef<boolean>(false);

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
    syncRoutesLayers(map, slotsRef.current);
    syncHighlightLayer(map, segmentHighlight);
  }, [segmentHighlight]);

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
      preserveDrawingBuffer: true,
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
    tilePickerControl.setOffline(isOfflineMode);
    map.addControl(centerRouteControl, 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-right');

    centerRouteControl.setOnCenter(() => {
      const currentMap = mapRef.current;
      if (!currentMap) return;
      fitRouteBounds(currentMap, slotsRef.current, waypointsRef.current, true);
    });

    onMapInstanceRef.current?.(map);

    const onStyleLoad = () => {
      styleReadyRef.current = true;
      drawAllLayers();
      if (pendingFitRouteRef.current) {
        pendingFitRouteRef.current = false;
        fitRouteBounds(map, slotsRef.current, waypointsRef.current, false);
      }
    };
    map.on('style.load', onStyleLoad);
    (map as any)._renderTaskQueue?.run?.();
    if (map.isStyleLoaded() || (map as any).style?._loaded) {
      onStyleLoad();
    }

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
    let pressTimer: ReturnType<typeof setTimeout> | undefined;

    const clearSingleClick = () => {
      if (singleClickTimer) {
        clearTimeout(singleClickTimer);
        singleClickTimer = undefined;
      }
    };

    const cancelPress = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = undefined;
      }
    };

    const findAvoidAreaAt = (p: LatLon, screenPoint?: { x: number; y: number }): number => {
      const currentAvoids = avoidAreasRef.current;
      if (screenPoint) {
        for (let i = currentAvoids.length - 1; i >= 0; i--) {
          const pt = map.project([currentAvoids[i].lon, currentAvoids[i].lat]);
          if (Math.hypot(pt.x - screenPoint.x, pt.y - screenPoint.y) <= 14) return i;
        }
      }
      for (let i = currentAvoids.length - 1; i >= 0; i--) {
        if (distanceMeters(p, currentAvoids[i]) <= Math.max(currentAvoids[i].radius, 18)) return i;
      }
      return -1;
    };

    const copyCoords = async (p: LatLon) => {
      const text = `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
      try {
        await navigator.clipboard.writeText(text);
        onStatusChangeRef.current(`Copied ${text}`);
      } catch (err: any) {
        onStatusChangeRef.current(`Could not copy: ${err?.message || String(err)}`);
      }
    };

    const openStreetView = (p: LatLon) => {
      window.open(
        `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p.lat.toFixed(6)},${p.lon.toFixed(6)}`,
        '_blank',
        'noopener,noreferrer',
      );
    };

    const showMapContextMenu = (p: LatLon, x: number, y: number) => {
      lastOpenedMarkerIndexRef.current = null;
      const wps = waypointsRef.current;
      const coordHeader = `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
      const items: MenuItem[] = [
        {
          label: 'Add point',
          hint: wps.length === 0 ? 'Start' : wps.length === 1 ? 'End' : 'Along route',
          onSelect: () => onAddWaypointRef.current(p, wps.length >= 2 ? 'via' : 'append'),
        },
        {
          label: 'Start here',
          hint: 'A',
          onSelect: () => onAddWaypointRef.current(p, 'start'),
        },
        {
          label: 'Via here',
          onSelect: () => onAddWaypointRef.current(p, 'via'),
        },
        {
          label: 'End here',
          hint: 'B',
          onSelect: () => onAddWaypointRef.current(p, 'end'),
        },
      ];

      if (wps.length >= 2) {
        items.push({
          label: 'Extend destination',
          hint: '+B',
          onSelect: () => onAddWaypointRef.current(p, 'append'),
        });
      }

      items.push(
        {
          label: 'Avoid here',
          hint: `${DEFAULT_AVOID_RADIUS_M} m`,
          dividerBefore: true,
          onSelect: () => onAddAvoidAreaRef.current(p, DEFAULT_AVOID_RADIUS_M),
        },
        {
          label: 'See on Google Street View',
          dividerBefore: true,
          onSelect: () => openStreetView(p),
        },
        {
          label: 'Copy coordinates',
          onSelect: () => copyCoords(p),
        },
      );

      showMenu(items, x, y, coordHeader);
    };

    const showAvoidContextMenu = (index: number, x: number, y: number) => {
      lastOpenedMarkerIndexRef.current = null;
      const area = avoidAreasRef.current[index];
      if (!area) return;
      const items: MenuItem[] = [
        ...AVOID_RADIUS_PRESETS.map((r) => ({
          label: `Radius: ${r} m`,
          active: Math.round(area.radius) === r,
          hint: Math.round(area.radius) === r ? 'Active' : undefined,
          onSelect: () => onUpdateAvoidAreaRadiusRef.current(index, r),
        })),
        {
          label: 'Remove avoid area',
          danger: true,
          dividerBefore: true,
          onSelect: () => onRemoveAvoidAreaRef.current(index),
        },
        {
          label: 'See on Google Street View',
          dividerBefore: true,
          onSelect: () => openStreetView(area),
        },
        {
          label: 'Copy coordinates',
          onSelect: () => copyCoords(area),
        },
      ];
      showMenu(items, x, y, `Avoid area (${Math.round(area.radius)} m)`);
    };

    map.on('click', (e) => {
      if (
        draggingMarkerIndexRef.current !== null ||
        performance.now() < suppressClickUntilRef.current ||
        menuClosedWithin(300)
      ) {
        return;
      }
      if ((e.originalEvent as MouseEvent)?.detail > 1) {
        clearSingleClick();
        return;
      }
      clearSingleClick();
      singleClickTimer = setTimeout(() => {
        singleClickTimer = undefined;
        if (
          draggingMarkerIndexRef.current !== null ||
          performance.now() < suppressClickUntilRef.current ||
          menuClosedWithin(300)
        ) {
          return;
        }
        const p = { lat: e.lngLat.lat, lon: e.lngLat.lng };
        const avoidIdx = findAvoidAreaAt(p, e.point);
        if (avoidIdx !== -1) {
          showAvoidContextMenu(avoidIdx, e.originalEvent.clientX, e.originalEvent.clientY);
        } else {
          showMapContextMenu(p, e.originalEvent.clientX, e.originalEvent.clientY);
        }
      }, 220);
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

    map.on('movestart', () => {
      clearSingleClick();
      cancelPress();
      hideMenu();
    });

    // Touch long-press
    map.on('touchstart', (e) => {
      clearSingleClick();
      cancelPress();
      if (e.points.length > 1 || (e.originalEvent.touches && e.originalEvent.touches.length > 1)) {
        suppressClickUntilRef.current = performance.now() + 600;
        if (insertDragRef.current) {
          insertDragRef.current.ghost?.remove();
          insertDragRef.current = null;
          map.getCanvas().style.cursor = '';
        }
        return;
      }
      if ((e.originalEvent.target as HTMLElement)?.closest('.wp-marker')) return;
      const touch = e.originalEvent.touches[0];
      pressTimer = setTimeout(() => {
        suppressClickUntilRef.current = performance.now() + 500;
        if (insertDragRef.current) {
          insertDragRef.current.ghost?.remove();
          insertDragRef.current = null;
        }
        const p = { lat: e.lngLat.lat, lon: e.lngLat.lng };
        const avoidIdx = findAvoidAreaAt(p, e.point);
        if (avoidIdx !== -1) {
          showAvoidContextMenu(avoidIdx, touch.clientX, touch.clientY);
        } else {
          showMapContextMenu(p, touch.clientX, touch.clientY);
        }
      }, LONG_PRESS_MS);
    });

    map.on('touchmove', cancelPress);
    map.on('touchend', cancelPress);
    map.on('touchcancel', cancelPress);

    const cancelInsert = () => {
      if (!insertDragRef.current) return;
      insertDragRef.current.ghost?.remove();
      insertDragRef.current = null;
      map.getCanvas().style.cursor = '';
    };

    const findClosestRouteCoords = (lng: number, lat: number): number[][] | undefined => {
      let bestCoords: number[][] | undefined;
      let bestDistSq = Infinity;
      for (const slot of slotsRef.current) {
        const coords = (
          slot.route?.features[0]?.geometry as GeoJSON.LineString | undefined
        )?.coordinates;
        if (!coords || coords.length === 0) continue;
        const idx = nearestVertex(coords, lng, lat);
        const dx = coords[idx][0] - lng;
        const dy = coords[idx][1] - lat;
        const dSq = dx * dx + dy * dy;
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          bestCoords = coords;
        }
      }
      return bestCoords;
    };

    // Route dragging insert logic
    const beginInsert = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
      if (draggingMarkerIndexRef.current !== null) return;
      const orig = e.originalEvent;
      if ('touches' in orig && orig.touches.length > 1) return;
      if (orig instanceof MouseEvent && orig.button !== 0) return;
      if ((orig.target as HTMLElement)?.closest('.wp-marker')) return;
      const coords = findClosestRouteCoords(e.lngLat.lng, e.lngLat.lat);
      const leg = legIndexAt(coords, waypointsRef.current, e.lngLat.lng, e.lngLat.lat);
      if (leg < 0) return;
      e.preventDefault();
      insertDragRef.current = {
        leg,
        startPoint: { x: e.point.x, y: e.point.y },
        ghost: null,
        hasDragged: false,
      };
    };

    const moveInsert = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
      if (draggingMarkerIndexRef.current !== null) return;
      const drag = insertDragRef.current;
      if (!drag) return;
      if ('touches' in e.originalEvent && e.originalEvent.touches.length > 1) {
        cancelInsert();
        return;
      }
      if (!drag.hasDragged) {
        const dx = e.point.x - drag.startPoint.x;
        const dy = e.point.y - drag.startPoint.y;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        drag.hasDragged = true;
        cancelPress();
        clearSingleClick();
        onHoverPositionRef.current?.(null);
        map.getCanvas().style.cursor = 'grabbing';
        const el = document.createElement('div');
        el.className = 'wp-marker ghost';
        el.textContent = '+';
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
      onInsertWaypointAtLegRef.current({ lat, lon: lng }, drag.leg + 1);
    };

    map.on('mousedown', 'route-hit', beginInsert);
    map.on('touchstart', 'route-hit', beginInsert);
    map.on('mousemove', moveInsert);
    map.on('touchmove', moveInsert);
    map.on('mouseup', finishInsert);
    map.on('touchend', finishInsert);
    map.on('touchcancel', cancelInsert);
    window.addEventListener('mouseup', finishInsert);

    map.on('mouseenter', 'route-hit', () => {
      if (draggingMarkerIndexRef.current === null) {
        map.getCanvas().style.cursor = 'grab';
      }
    });
    map.on('mousemove', 'route-hit', (e) => {
      if (insertDragRef.current?.hasDragged || draggingMarkerIndexRef.current !== null) return;
      const coords = findClosestRouteCoords(e.lngLat.lng, e.lngLat.lat);
      if (coords && coords.length > 0) {
        const idx = nearestVertex(coords, e.lngLat.lng, e.lngLat.lat);
        onHoverPositionRef.current?.({ lon: coords[idx][0], lat: coords[idx][1] });
      }
    });
    map.on('mouseleave', 'route-hit', () => {
      if (!insertDragRef.current?.hasDragged) map.getCanvas().style.cursor = '';
      onHoverPositionRef.current?.(null);
    });
    map.on('mouseenter', 'nogo-areas-fill', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'nogo-areas-fill', () => (map.getCanvas().style.cursor = ''));
    map.on('mouseenter', 'nogo-areas-center', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'nogo-areas-center', () => (map.getCanvas().style.cursor = ''));

    return () => {
      window.removeEventListener('mouseup', finishInsert);
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      hoverMarkerRef.current?.remove();
      hoverMarkerRef.current = null;
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

  useEffect(() => {
    if (mapRef.current && styleReadyRef.current) {
      syncRoutesLayers(mapRef.current, slots);
      const anyRoute = slots.some((s) => Boolean(s.route?.features?.length));
      if (anyRoute && pendingFitRouteRef.current) {
        pendingFitRouteRef.current = false;
        fitRouteBounds(mapRef.current, slots, waypointsRef.current, true);
      }
    }
  }, [slots]);

  // Fit bounds only when explicitly requested via fitBoundsSeq (initial load, import GPX, etc.)
  useEffect(() => {
    if (fitBoundsSeq === 0) return;
    const map = mapRef.current;
    const anyRoute = slotsRef.current.some((s) => Boolean(s.route?.features?.length));
    if (anyRoute && map && styleReadyRef.current) {
      pendingFitRouteRef.current = false;
      fitRouteBounds(map, slotsRef.current, waypointsRef.current, true);
    } else {
      pendingFitRouteRef.current = true;
      if (map && styleReadyRef.current) {
        fitRouteBounds(map, [], waypointsRef.current, true);
      }
    }
  }, [fitBoundsSeq]);

  useEffect(() => {
    const canCenter =
      waypoints.length > 0 || slots.some((s) => Boolean(s.route?.features?.length));
    centerRouteControl.setEnabled(canCenter);
  }, [waypoints, slots]);

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

  // Waypoint markers synchronization (reuses existing Marker instances so active drags are never interrupted)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const n = waypoints.length;
    const currentMarkers = markersRef.current;

    // Remove excess markers from the end if waypoints were removed
    while (currentMarkers.length > n) {
      const removed = currentMarkers.pop();
      removed?.remove();
    }

    waypoints.forEach((w, index) => {
      const label = waypointLabel(index, n);
      const kind = waypointKind(index, n);
      const titleText = w.name
        ? `${label}: ${w.name}`
        : `${label}: ${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}`;

      const existing = currentMarkers[index];
      if (existing) {
        const el = existing.getElement();
        el.classList.remove('start', 'end', 'via');
        el.classList.add('maplibregl-marker', 'maplibregl-marker-anchor-center', 'wp-marker', kind);
        el.textContent = label;
        el.title = titleText;
        if (draggingMarkerIndexRef.current !== index) {
          existing.setLngLat([w.lon, w.lat]);
        }
        return;
      }

      const el = document.createElement('div');
      el.classList.add('wp-marker', kind);
      el.textContent = label;
      el.title = titleText;

      let wasDragged = false;
      const marker = new maplibregl.Marker({ element: el, draggable: true, clickTolerance: 4 })
        .setLngLat([w.lon, w.lat])
        .addTo(map);

      marker.on('dragstart', () => {
        wasDragged = true;
        draggingMarkerIndexRef.current = index;
        suppressClickUntilRef.current = performance.now() + 10000;
        onHoverPositionRef.current?.(null);
        hideMenu();
      });

      marker.on('dragend', () => {
        draggingMarkerIndexRef.current = null;
        suppressClickUntilRef.current = performance.now() + 300;
        const { lat, lng } = marker.getLngLat();
        onMoveWaypointRef.current(index, { lat, lon: lng });
        setTimeout(() => {
          wasDragged = false;
        }, 150);
      });

      const showMarkerContextMenu = (e: MouseEvent) => {
        const currentWp = waypointsRef.current[index];
        if (!currentWp) return;
        const currentN = waypointsRef.current.length;
        const currentLabel = waypointLabel(index, currentN);
        const headerTitle = currentWp.name ? `${currentLabel} · ${currentWp.name}` : `Point ${currentLabel}`;
        lastOpenedMarkerIndexRef.current = index;
        const rect = el.getBoundingClientRect();
        const x = e.clientX || rect.left + rect.width / 2;
        const y = e.clientY || rect.bottom + 4;
        showMenu(
          [
            {
              label: 'Rename point',
              onSelect: () => {
                if (onRequestInlineRenameRef.current) {
                  onRequestInlineRenameRef.current(index);
                } else {
                  const currentName = waypointsRef.current[index]?.name || '';
                  const nextName = window.prompt('Rename point:', currentName);
                  if (nextName !== null) {
                    onRenameWaypointRef.current(index, nextName);
                  }
                }
              },
            },
            {
              label: 'Remove point',
              danger: true,
              onSelect: () => onRemoveWaypointRef.current(index),
            },
            {
              label: 'See on Google Street View',
              dividerBefore: true,
              onSelect: () => {
                const wp = waypointsRef.current[index];
                if (!wp) return;
                window.open(
                  `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${wp.lat.toFixed(6)},${wp.lon.toFixed(6)}`,
                  '_blank',
                  'noopener,noreferrer',
                );
              },
            },
            {
              label: 'Copy coordinates',
              onSelect: async () => {
                const wp = waypointsRef.current[index];
                if (!wp) return;
                const text = `${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)}`;
                await navigator.clipboard.writeText(text);
                onStatusChangeRef.current(`Copied ${text}`);
              },
            },
          ],
          x,
          y,
          headerTitle,
        );
      };

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (wasDragged) return;
        if (lastOpenedMarkerIndexRef.current === index && menuClosedWithin(250)) {
          lastOpenedMarkerIndexRef.current = null;
          return;
        }
        showMarkerContextMenu(e);
      });

      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showMarkerContextMenu(e);
      });

      currentMarkers.push(marker);
    });
  }, [waypoints]);

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

