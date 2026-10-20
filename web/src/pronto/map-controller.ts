import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as pmtiles from 'pmtiles';
import {
  AVOID_RADIUS_PRESETS,
  waypointKind,
  waypointLabel,
  type AvoidArea,
  type Basemap,
  type LatLon,
  type RouteSlotState,
  type SegmentHighlight,
} from '../types.ts';
import { getOfflineStyle, getOnlineStyle, UK_CENTER, UK_BOUNDS } from '../utils/map-styles.ts';
import { tilePickerControl } from '../tile-picker.ts';
import { centerRouteControl } from '../center-control.ts';
import { loadedPMTiles, archivesReady } from './offline-controller.ts';
import { MAP_TILES_CACHE_NAME } from '../segment-cache.ts';
import { showMenu, hideMenu, menuClosedWithin, type MenuItem } from '../menu.ts';
import { distanceMeters, legIndexAt, nearestVertex } from '../utils/geo.ts';
import {
  syncAvoidAreasLayer,
  syncRoutesLayers,
  syncHighlightLayer,
  fitRouteBounds,
} from '../utils/map-layers.ts';

export const DEFAULT_AVOID_RADIUS_M = 50;
const LONG_PRESS_MS = 550;
const DRAG_THRESHOLD_PX = 8;

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

export interface MapControllerCallbacks {
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
}

export class MapController {
  public map: maplibregl.Map;
  private styleReady = false;
  private pendingFitRoute = false;
  private markers: maplibregl.Marker[] = [];
  private hoverMarker: maplibregl.Marker | null = null;
  private draggingMarkerIndex: number | null = null;
  private lastOpenedMarkerIndex: number | null = null;
  private suppressClickUntil = 0;
  private insertDrag: {
    leg: number;
    startPoint: { x: number; y: number };
    ghost: maplibregl.Marker | null;
    hasDragged: boolean;
  } | null = null;

  private waypoints: LatLon[] = [];
  private avoidAreas: AvoidArea[] = [];
  private slots: RouteSlotState[] = [];
  private segmentHighlight: SegmentHighlight | null = null;
  private prevStyleProps: { isOfflineMode: boolean; basemap: Basemap; thunderforestKey: string };
  private finishInsertBound: () => void;

  constructor(
    container: HTMLElement,
    initialOfflineMode: boolean,
    initialBasemap: Basemap,
    initialThunderforestKey: string,
    private callbacks: MapControllerCallbacks,
  ) {
    registerProtocols();
    this.prevStyleProps = {
      isOfflineMode: initialOfflineMode,
      basemap: initialBasemap,
      thunderforestKey: initialThunderforestKey,
    };

    const map = new maplibregl.Map({
      container,
      style: initialOfflineMode
        ? getOfflineStyle()
        : getOnlineStyle(initialBasemap, initialThunderforestKey),
      center: UK_CENTER,
      zoom: 6,
      maxBounds: initialOfflineMode ? UK_BOUNDS : undefined,
      attributionControl: false,
      preserveDrawingBuffer: true,
    });
    this.map = map;
    (window as any).map = map;
    (window as any).__rsrouterMap = map;

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: false, maximumAge: 60000 },
        trackUserLocation: true,
        showAccuracyCircle: true,
      }),
      'top-right',
    );
    map.addControl(tilePickerControl, 'top-right');
    tilePickerControl.setOffline(initialOfflineMode);
    map.addControl(centerRouteControl, 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-right');

    centerRouteControl.setOnCenter(() => {
      fitRouteBounds(this.map, this.slots, this.waypoints, true);
    });

    const onStyleLoad = () => {
      this.styleReady = true;
      this.drawAllLayers();
      if (this.pendingFitRoute) {
        this.pendingFitRoute = false;
        fitRouteBounds(map, this.slots, this.waypoints, false);
      }
    };
    map.on('style.load', onStyleLoad);
    if ((map as any).style && !(map as any).style._loaded && document.hidden) {
      const style = initialOfflineMode
        ? getOfflineStyle()
        : getOnlineStyle(initialBasemap, initialThunderforestKey);
      try {
        (map as any).style._frameRequest?.abort?.();
        (map as any).style._frameRequest = null;
        (map as any).style._load?.(style, { validate: false });
      } catch {
        // ignore
      }
    }
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
      const currentAvoids = this.avoidAreas;
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
        this.callbacks.onStatusChange(`Copied ${text}`);
      } catch (err: any) {
        this.callbacks.onStatusChange(`Could not copy: ${err?.message || String(err)}`);
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
      this.lastOpenedMarkerIndex = null;
      const wps = this.waypoints;
      const coordHeader = `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
      const items: MenuItem[] = [
        {
          label: 'Add point',
          hint: wps.length === 0 ? 'Start' : wps.length === 1 ? 'End' : 'Along route',
          onSelect: () => this.callbacks.onAddWaypoint(p, wps.length >= 2 ? 'via' : 'append'),
        },
        {
          label: 'Start here',
          hint: 'A',
          onSelect: () => this.callbacks.onAddWaypoint(p, 'start'),
        },
        {
          label: 'Via here',
          onSelect: () => this.callbacks.onAddWaypoint(p, 'via'),
        },
        {
          label: 'End here',
          hint: 'B',
          onSelect: () => this.callbacks.onAddWaypoint(p, 'end'),
        },
      ];

      if (wps.length >= 2) {
        items.push({
          label: 'Extend destination',
          hint: '+B',
          onSelect: () => this.callbacks.onAddWaypoint(p, 'append'),
        });
      }

      items.push(
        {
          label: 'Avoid here',
          hint: `${DEFAULT_AVOID_RADIUS_M} m`,
          dividerBefore: true,
          onSelect: () => this.callbacks.onAddAvoidArea(p, DEFAULT_AVOID_RADIUS_M),
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
      this.lastOpenedMarkerIndex = null;
      const area = this.avoidAreas[index];
      if (!area) return;
      const items: MenuItem[] = [
        ...AVOID_RADIUS_PRESETS.map((r) => ({
          label: `Radius: ${r} m`,
          active: Math.round(area.radius) === r,
          hint: Math.round(area.radius) === r ? 'Active' : undefined,
          onSelect: () => this.callbacks.onUpdateAvoidAreaRadius(index, r),
        })),
        {
          label: 'Remove avoid area',
          danger: true,
          dividerBefore: true,
          onSelect: () => this.callbacks.onRemoveAvoidArea(index),
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
        this.draggingMarkerIndex !== null ||
        performance.now() < this.suppressClickUntil ||
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
          this.draggingMarkerIndex !== null ||
          performance.now() < this.suppressClickUntil ||
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

    map.on('touchstart', (e) => {
      clearSingleClick();
      cancelPress();
      if (e.points.length > 1 || (e.originalEvent.touches && e.originalEvent.touches.length > 1)) {
        this.suppressClickUntil = performance.now() + 600;
        if (this.insertDrag) {
          this.insertDrag.ghost?.remove();
          this.insertDrag = null;
          map.getCanvas().style.cursor = '';
        }
        return;
      }
      if ((e.originalEvent.target as HTMLElement)?.closest('.wp-marker')) return;
      const touch = e.originalEvent.touches[0];
      pressTimer = setTimeout(() => {
        this.suppressClickUntil = performance.now() + 500;
        if (this.insertDrag) {
          this.insertDrag.ghost?.remove();
          this.insertDrag = null;
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
      if (!this.insertDrag) return;
      this.insertDrag.ghost?.remove();
      this.insertDrag = null;
      map.getCanvas().style.cursor = '';
    };

    const findClosestRouteCoords = (lng: number, lat: number): number[][] | undefined => {
      let bestCoords: number[][] | undefined;
      let bestDistSq = Infinity;
      for (const slot of this.slots) {
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

    const beginInsert = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
      if (this.draggingMarkerIndex !== null) return;
      const orig = e.originalEvent;
      if ('touches' in orig && orig.touches.length > 1) return;
      if (orig instanceof MouseEvent && orig.button !== 0) return;
      if ((orig.target as HTMLElement)?.closest('.wp-marker')) return;
      const coords = findClosestRouteCoords(e.lngLat.lng, e.lngLat.lat);
      const leg = legIndexAt(coords, this.waypoints, e.lngLat.lng, e.lngLat.lat);
      if (leg < 0) return;
      e.preventDefault();
      this.insertDrag = {
        leg,
        startPoint: { x: e.point.x, y: e.point.y },
        ghost: null,
        hasDragged: false,
      };
    };

    const moveInsert = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
      if (this.draggingMarkerIndex !== null) return;
      const drag = this.insertDrag;
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
        this.callbacks.onHoverPosition?.(null);
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
      const drag = this.insertDrag;
      if (!drag) return;
      drag.ghost?.remove();
      this.insertDrag = null;
      map.getCanvas().style.cursor = '';
      if (!drag.hasDragged || !drag.ghost) return;
      this.suppressClickUntil = performance.now() + 400;
      const { lat, lng } = drag.ghost.getLngLat();
      this.callbacks.onInsertWaypointAtLeg({ lat, lon: lng }, drag.leg + 1);
    };
    this.finishInsertBound = finishInsert;

    map.on('mousedown', 'route-hit', beginInsert);
    map.on('touchstart', 'route-hit', beginInsert);
    map.on('mousemove', moveInsert);
    map.on('touchmove', moveInsert);
    map.on('mouseup', finishInsert);
    map.on('touchend', finishInsert);
    map.on('touchcancel', cancelInsert);
    window.addEventListener('mouseup', this.finishInsertBound);

    map.on('mouseenter', 'route-hit', () => {
      if (this.draggingMarkerIndex === null) {
        map.getCanvas().style.cursor = 'grab';
      }
    });
    map.on('mousemove', 'route-hit', (e) => {
      if (this.insertDrag?.hasDragged || this.draggingMarkerIndex !== null) return;
      const coords = findClosestRouteCoords(e.lngLat.lng, e.lngLat.lat);
      if (coords && coords.length > 0) {
        const idx = nearestVertex(coords, e.lngLat.lng, e.lngLat.lat);
        this.callbacks.onHoverPosition?.({ lon: coords[idx][0], lat: coords[idx][1] });
      }
    });
    map.on('mouseleave', 'route-hit', () => {
      if (!this.insertDrag?.hasDragged) map.getCanvas().style.cursor = '';
      this.callbacks.onHoverPosition?.(null);
    });
    map.on('mouseenter', 'nogo-areas-fill', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'nogo-areas-fill', () => (map.getCanvas().style.cursor = ''));
    map.on('mouseenter', 'nogo-areas-center', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'nogo-areas-center', () => (map.getCanvas().style.cursor = ''));
  }

  private drawAllLayers() {
    if (!this.styleReady) return;
    syncAvoidAreasLayer(this.map, this.avoidAreas);
    syncRoutesLayers(this.map, this.slots);
    syncHighlightLayer(this.map, this.segmentHighlight);
  }

  updateStyleSettings(isOfflineMode: boolean, basemap: Basemap, thunderforestKey: string) {
    const prev = this.prevStyleProps;
    if (
      prev.isOfflineMode === isOfflineMode &&
      prev.basemap === basemap &&
      prev.thunderforestKey === thunderforestKey
    ) {
      return;
    }
    this.prevStyleProps = { isOfflineMode, basemap, thunderforestKey };
    this.styleReady = false;
    this.map.setMaxBounds(isOfflineMode ? UK_BOUNDS : null);
    tilePickerControl.setOffline(isOfflineMode);
    this.map.setStyle(
      isOfflineMode ? getOfflineStyle() : getOnlineStyle(basemap, thunderforestKey),
      { diff: false },
    );
  }

  updateSlots(slots: RouteSlotState[]) {
    this.slots = slots;
    const canCenter =
      this.waypoints.length > 0 || slots.some((s) => Boolean(s.route?.features?.length));
    centerRouteControl.setEnabled(canCenter);

    if (this.styleReady) {
      syncRoutesLayers(this.map, slots);
      const anyRoute = slots.some((s) => Boolean(s.route?.features?.length));
      if (anyRoute && this.pendingFitRoute) {
        this.pendingFitRoute = false;
        fitRouteBounds(this.map, slots, this.waypoints, true);
      }
    }
  }

  updateWaypoints(waypoints: LatLon[]) {
    this.waypoints = waypoints;
    const canCenter =
      waypoints.length > 0 || this.slots.some((s) => Boolean(s.route?.features?.length));
    centerRouteControl.setEnabled(canCenter);
    this.syncWaypointMarkers();
  }

  updateAvoidAreas(avoidAreas: AvoidArea[]) {
    this.avoidAreas = avoidAreas;
    if (this.styleReady) {
      syncAvoidAreasLayer(this.map, avoidAreas);
    }
  }

  updateSegmentHighlight(highlight: SegmentHighlight | null) {
    this.segmentHighlight = highlight;
    if (this.styleReady) {
      syncHighlightLayer(this.map, highlight);
    }
  }

  updateHoverPosition(hoverPosition: { lat: number; lon: number } | null) {
    if (!hoverPosition) {
      this.hoverMarker?.remove();
      this.hoverMarker = null;
      return;
    }
    if (!this.hoverMarker) {
      const el = document.createElement('div');
      el.className = 'hover-dot';
      this.hoverMarker = new maplibregl.Marker({ element: el })
        .setLngLat([hoverPosition.lon, hoverPosition.lat])
        .addTo(this.map);
    } else {
      this.hoverMarker.setLngLat([hoverPosition.lon, hoverPosition.lat]);
    }
  }

  triggerFitBounds() {
    const anyRoute = this.slots.some((s) => Boolean(s.route?.features?.length));
    if (anyRoute && this.styleReady) {
      this.pendingFitRoute = false;
      fitRouteBounds(this.map, this.slots, this.waypoints, true);
    } else {
      this.pendingFitRoute = true;
      if (this.styleReady) {
        fitRouteBounds(this.map, [], this.waypoints, true);
      }
    }
  }

  flyTo(lon: number, lat: number, zoom = 14) {
    this.map.flyTo({
      center: [lon, lat],
      zoom,
      duration: 600,
    });
  }

  private syncWaypointMarkers() {
    const n = this.waypoints.length;
    const currentMarkers = this.markers;

    while (currentMarkers.length > n) {
      const removed = currentMarkers.pop();
      removed?.remove();
    }

    this.waypoints.forEach((w, index) => {
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
        if (this.draggingMarkerIndex !== index) {
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
        .addTo(this.map);

      marker.on('dragstart', () => {
        wasDragged = true;
        this.draggingMarkerIndex = index;
        this.suppressClickUntil = performance.now() + 10000;
        this.callbacks.onHoverPosition?.(null);
        hideMenu();
      });

      marker.on('dragend', () => {
        this.draggingMarkerIndex = null;
        this.suppressClickUntil = performance.now() + 300;
        const { lat, lng } = marker.getLngLat();
        this.callbacks.onMoveWaypoint(index, { lat, lon: lng });
        setTimeout(() => {
          wasDragged = false;
        }, 150);
      });

      const showMarkerContextMenu = (e: MouseEvent) => {
        const currentWp = this.waypoints[index];
        if (!currentWp) return;
        const currentN = this.waypoints.length;
        const currentLabel = waypointLabel(index, currentN);
        const headerTitle = currentWp.name
          ? `${currentLabel} · ${currentWp.name}`
          : `Point ${currentLabel}`;
        this.lastOpenedMarkerIndex = index;
        const rect = el.getBoundingClientRect();
        const x = e.clientX || rect.left + rect.width / 2;
        const y = e.clientY || rect.bottom + 4;
        showMenu(
          [
            {
              label: 'Rename point',
              onSelect: () => {
                if (this.callbacks.onRequestInlineRename) {
                  this.callbacks.onRequestInlineRename(index);
                } else {
                  const currentName = this.waypoints[index]?.name || '';
                  const nextName = window.prompt('Rename point:', currentName);
                  if (nextName !== null) {
                    this.callbacks.onRenameWaypoint(index, nextName);
                  }
                }
              },
            },
            {
              label: 'Remove point',
              danger: true,
              onSelect: () => this.callbacks.onRemoveWaypoint(index),
            },
            {
              label: 'See on Google Street View',
              dividerBefore: true,
              onSelect: () => {
                const wp = this.waypoints[index];
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
                const wp = this.waypoints[index];
                if (!wp) return;
                const text = `${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)}`;
                await navigator.clipboard.writeText(text);
                this.callbacks.onStatusChange(`Copied ${text}`);
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
        if (this.lastOpenedMarkerIndex === index && menuClosedWithin(250)) {
          this.lastOpenedMarkerIndex = null;
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
  }

  destroy() {
    window.removeEventListener('mouseup', this.finishInsertBound);
    this.markers.forEach((m) => m.remove());
    this.markers = [];
    this.hoverMarker?.remove();
    this.hoverMarker = null;
    this.map.remove();
  }
}
