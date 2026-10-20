import type maplibregl from 'maplibre-gl';
import {
  classifyNoise,
  classifyRoad,
  classifySpeedLimit,
  classifySurface,
  classifyTraffic,
  ROAD_META,
  SURFACE_META,
} from './pronto/route-domain.js';
import { buildProfile, nearestIndex } from './utils/geo.ts';
import { searchPlaces } from './geocoding.ts';
import type {
  AvoidArea,
  Basemap,
  LatLon,
  ProfileName,
  RoadCategory,
  RouteSlotState,
  SegmentData,
  SegmentHighlight,
  SurfaceCategory,
  Theme,
  Units,
} from './types.ts';
import { getOfflineStyle, getOnlineStyle } from './utils/map-styles.ts';

export type StateSetter<T> = (next: T | ((prev: T) => T)) => void;

export interface McpUiControls {
  isControlsCollapsed: boolean;
  setIsControlsCollapsed: StateSetter<boolean>;
  isRouteInfoCollapsed: boolean;
  setIsRouteInfoCollapsed: StateSetter<boolean>;
  isSettingsOpen: boolean;
  setIsSettingsOpen: StateSetter<boolean>;
  isAboutOpen: boolean;
  setIsAboutOpen: StateSetter<boolean>;
  hoverPosition: { lat: number; lon: number } | null;
  setHoverPosition: StateSetter<{ lat: number; lon: number } | null>;
  segmentHighlight: SegmentHighlight | null;
  setSegmentHighlight: StateSetter<SegmentHighlight | null>;
}

export interface McpRoutingController {
  slots: RouteSlotState[];
  addProfileSlot: (profile?: ProfileName) => void;
  removeProfileSlot: (slotIdx: number) => void;
  setSlotProfile: (slotIdx: number, profile: ProfileName) => void;
  selectSlotAlternative: (slotIdx: number, altIdx: number) => void;
  profile: ProfileName;
  setProfile: (profile: ProfileName) => void;
  waypoints: LatLon[];
  setWaypoints: (waypoints: LatLon[], recordHistory?: boolean, fitBounds?: boolean) => void;
  avoidAreas: AvoidArea[];
  setAvoidAreas: (avoidAreas: AvoidArea[], recordHistory?: boolean) => void;
  currentRoute: GeoJSON.FeatureCollection | null;
  alternativeIdx: number;
  selectAlternative: (altIdx: number) => void;
  status: string;
  isError: boolean;
  setStatus: (msg: string, isError?: boolean) => void;
  isRouting: boolean;
  canUndo: boolean;
  canRedo: boolean;
  triggerFitBounds: () => void;
  importGpxContent: (gpxXml: string, toleranceM?: number) => void;
  addWaypoint: (point: LatLon, mode?: 'start' | 'end' | 'via' | 'append') => void;
  moveWaypoint: (index: number, point: LatLon) => void;
  removeWaypoint: (index: number) => void;
  renameWaypoint: (index: number, name: string) => void;
  reverseRoute: () => void;
  addAvoidArea: (point: LatLon, radius?: number) => void;
  removeAvoidArea: (index: number) => void;
  clearAvoidAreas: () => void;
  clearRoute: () => void;
  undo: () => void;
  redo: () => void;
}

export interface McpOfflineController {
  isOfflineMode: boolean;
  setOfflineMode: (enabled: boolean) => void;
}

export interface McpSettingsController {
  units: Units;
  theme: Theme;
  basemap: Basemap;
  thunderforestKey: string;
  changeUnits: (next: Units) => void;
  changeTheme: (next: Theme) => void;
  changeBasemap: (next: Basemap) => void;
  changeThunderforestKey: (next: string) => void;
}

export interface McpBridgeContext {
  mapRef: { current: maplibregl.Map | null };
  routing: McpRoutingController;
  offline: McpOfflineController;
  settings: McpSettingsController;
  ui: McpUiControls;
}

interface JourneyEntry {
  timestamp: string;
  command: string;
  args: Record<string, any>;
  waypointCount: number;
  hasRoute: boolean;
  status: string;
}

const journeyLog: JourneyEntry[] = [];

function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(null);
  });
}

async function sleep(ms: number): Promise<void> {
  if (document.hidden) {
    const turns = Math.max(1, Math.min(20, Math.ceil(ms / 15)));
    for (let i = 0; i < turns; i++) {
      await nextTurn();
    }
    return;
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeRoute(currentRoute: GeoJSON.FeatureCollection | null, slotIdx = 0) {
  if (!currentRoute || currentRoute.features.length === 0) return null;
  const feat = currentRoute.features[0];
  const props = (feat.properties || {}) as Record<string, any>;
  const coords = (feat.geometry as GeoJSON.LineString).coordinates;
  const segs: SegmentData[] = props.segments || [];

  const surfaceMeters: Record<string, number> = {};
  const roadMeters: Record<string, number> = {};
  const trafficMeters: Record<string, number> = {};
  const noiseMeters: Record<string, number> = {};
  const speedLimitMeters: Record<string, number> = {};

  for (const s of segs) {
    const len = Math.max(0, s.to - s.from);
    if (len === 0) continue;
    const surf = classifySurface(s.surface, s.highway);
    const road = classifyRoad(s.highway);
    const traf = classifyTraffic(s.traffic, s.highway);
    const noise = classifyNoise(s.noise);
    const spd = classifySpeedLimit(s.maxspeed, s.highway);
    surfaceMeters[surf] = (surfaceMeters[surf] || 0) + len;
    roadMeters[road] = (roadMeters[road] || 0) + len;
    trafficMeters[traf] = (trafficMeters[traf] || 0) + len;
    noiseMeters[noise] = (noiseMeters[noise] || 0) + len;
    speedLimitMeters[spd] = (speedLimitMeters[spd] || 0) + len;
  }

  const textOf = (baseId: string) => {
    const id = slotIdx === 0 ? baseId : `${baseId}-${slotIdx}`;
    return document.getElementById(id)?.textContent?.trim() || null;
  };

  return {
    distanceMeters: Number(props['track-length'] || 0),
    timeSeconds: Number(props['total-time'] || 0),
    filteredAscentMeters: Number(props['filtered ascend'] || 0),
    plainAscentMeters: Number(props['plain-ascend'] || 0),
    cost: Number(props['cost'] || 0),
    coordinateCount: coords.length,
    segmentCount: segs.length,
    surfaceBreakdownMeters: surfaceMeters,
    roadBreakdownMeters: roadMeters,
    trafficBreakdownMeters: trafficMeters,
    noiseBreakdownMeters: noiseMeters,
    speedLimitBreakdownMeters: speedLimitMeters,
    displayedStats: {
      distance: textOf('ri-distance'),
      time: textOf('ri-time'),
      ascent: textOf('ri-ascent'),
      descent: textOf('ri-descent'),
      speed: textOf('ri-speed'),
    },
  };
}

function buildStateSnapshot(ctx: McpBridgeContext) {
  const map = ctx.mapRef.current;
  const center = map ? map.getCenter() : null;
  const bounds = map ? map.getBounds() : null;

  const hasLayerFeatures = (sourceId: string): number => {
    if (!map) return 0;
    const src = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
    if (!src) return 0;
    const data = (src as any)._data as GeoJSON.FeatureCollection | undefined;
    return data && Array.isArray(data.features) ? data.features.length : 0;
  };

  return {
    waypoints: ctx.routing.waypoints,
    profile: ctx.routing.profile,
    alternativeIdx: ctx.routing.alternativeIdx,
    slots: ctx.routing.slots.map((s, idx) => ({
      slotIdx: idx,
      profile: s.profile,
      alternativeIdx: s.alternativeIdx,
      isRouting: s.isRouting,
      routeSummary: summarizeRoute(s.route, idx),
    })),
    avoidAreas: ctx.routing.avoidAreas,
    status: ctx.routing.status,
    isError: ctx.routing.isError,
    isRouting: ctx.routing.isRouting,
    canUndo: ctx.routing.canUndo,
    canRedo: ctx.routing.canRedo,
    routeSummary: summarizeRoute(ctx.routing.currentRoute, 0),
    ui: {
      isControlsCollapsed: ctx.ui.isControlsCollapsed,
      isRouteInfoCollapsed: ctx.ui.isRouteInfoCollapsed,
      isSettingsOpen: ctx.ui.isSettingsOpen,
      isAboutOpen: ctx.ui.isAboutOpen,
      hoverPosition: ctx.ui.hoverPosition,
      hasSegmentHighlight: Boolean(ctx.ui.segmentHighlight),
      units: ctx.settings.units,
      theme: ctx.settings.theme,
      basemap: ctx.settings.basemap,
      isOfflineMode: ctx.offline.isOfflineMode,
      viewport: {
        width: simulatedViewport?.width || window.innerWidth,
        height: simulatedViewport?.height || window.innerHeight,
        simulated: Boolean(simulatedViewport),
      },
    },
    map: map
      ? {
          center: center ? { lon: Number(center.lng.toFixed(6)), lat: Number(center.lat.toFixed(6)) } : null,
          zoom: Number(map.getZoom().toFixed(2)),
          bounds: bounds
            ? {
                west: Number(bounds.getWest().toFixed(5)),
                south: Number(bounds.getSouth().toFixed(5)),
                east: Number(bounds.getEast().toFixed(5)),
                north: Number(bounds.getNorth().toFixed(5)),
              }
            : null,
          domMarkerCount: document.querySelectorAll('.maplibregl-marker').length,
          routeSourceFeatures: hasLayerFeatures('route'),
          route1SourceFeatures: hasLayerFeatures('route-1'),
          route2SourceFeatures: hasLayerFeatures('route-2'),
          avoidSourceFeatures: hasLayerFeatures('nogo-areas'),
          highlightSourceFeatures: hasLayerFeatures('route-segment-highlight'),
        }
      : null,
  };
}

async function pumpMapFrames(map: maplibregl.Map, durationMs = 400): Promise<void> {
  if ((map as any).style && !(map as any).style._loaded && activeCtxRef.current) {
    const cur = activeCtxRef.current;
    const style = cur.offline.isOfflineMode
      ? getOfflineStyle()
      : getOnlineStyle(cur.settings.basemap, cur.settings.thunderforestKey);
    try {
      (map as any).style._frameRequest?.abort?.();
      (map as any).style._frameRequest = null;
      (map as any).style._load?.(style, { validate: false });
    } catch {
      // ignore
    }
  }
  if (document.hidden) {
    for (let i = 0; i < 12; i++) {
      try {
        map.triggerRepaint();
        (map as any)._renderTaskQueue?.run?.();
        (map as any)._render?.(performance.now());
      } catch {
        // ignore
      }
      await nextTurn();
    }
    return;
  }
  return new Promise<void>((resolve) => {
    const start = Date.now();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      clearTimeout(timer);
      resolve();
    };
    const interval = setInterval(() => {
      try {
        map.triggerRepaint();
        (map as any)._renderTaskQueue?.run?.();
        (map as any)._render?.(performance.now());
      } catch {
        // ignore
      }
      if (Date.now() - start >= durationMs && map.loaded()) {
        finish();
      }
    }, 40);
    const timer = setTimeout(finish, Math.max(durationMs, 1200));
    map.once('idle', () => {
      try {
        (map as any)._renderTaskQueue?.run?.();
        (map as any)._render?.(performance.now());
      } catch {
        // ignore
      }
      finish();
    });
  });
}

async function waitForRoutingIdle(
  ctxRef: { current: McpBridgeContext },
  timeoutMs = 15000,
): Promise<void> {
  // Let React state updates and worker postMessage flush first
  await sleep(80);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!ctxRef.current.routing.isRouting) {
      await sleep(60);
      if (!ctxRef.current.routing.isRouting) break;
    }
    await sleep(60);
  }
  const map = ctxRef.current.mapRef.current;
  if (map) {
    await pumpMapFrames(map, 500);
  }
}

function buildCategorySegmentHighlight(
  currentRoute: GeoJSON.FeatureCollection | null,
  kind: 'surface' | 'road',
  category: string,
): SegmentHighlight | null {
  if (!currentRoute || currentRoute.features.length === 0) return null;
  const feat = currentRoute.features[0];
  const props = (feat.properties || {}) as Record<string, any>;
  const coords = (feat.geometry as GeoJSON.LineString).coordinates;
  const segs: SegmentData[] = props.segments || [];
  const profile = buildProfile(coords);
  if (profile.coords.length < 2) return null;

  const matchingCoords: number[][][] = [];
  for (const s of segs) {
    const len = Math.max(0, s.to - s.from);
    if (len === 0) continue;
    const cat =
      kind === 'surface' ? classifySurface(s.surface, s.highway) : classifyRoad(s.highway);
    if (cat !== category) continue;

    let i0 = nearestIndex(profile.dist, s.from);
    let i1 = nearestIndex(profile.dist, s.to);
    if (i1 <= i0) {
      if (i0 < profile.coords.length - 1) i1 = i0 + 1;
      else {
        i0 = Math.max(0, profile.coords.length - 2);
        i1 = profile.coords.length - 1;
      }
    }
    const slice = profile.coords.slice(i0, i1 + 1).map((pt) => [pt[0], pt[1]]);
    if (slice.length >= 2) {
      matchingCoords.push(slice);
    }
  }

  if (matchingCoords.length === 0) return null;
  const color =
    kind === 'surface'
      ? SURFACE_META[category as SurfaceCategory]?.color || '#3b82f6'
      : ROAD_META[category as RoadCategory]?.color || '#3b82f6';
  return { coordinates: matchingCoords, color };
}

let simulatedViewport: { width: number; height: number } | null = null;
const origMediaTextMap = new WeakMap<CSSMediaRule, string>();

function doesMediaRuleMatchWidth(mediaText: string, vw: number): boolean {
  const maxMatch = mediaText.match(/max-width:\s*(\d+)px/i);
  if (maxMatch) return vw <= Number(maxMatch[1]);
  const minMatch = mediaText.match(/min-width:\s*(\d+)px/i);
  if (minMatch) return vw >= Number(minMatch[1]);
  return window.matchMedia(mediaText).matches;
}

async function applySimulatedViewport(
  ctx: McpBridgeContext,
  vp: { width: number; height: number } | null,
) {
  simulatedViewport = vp;
  const rootEl = document.getElementById('root');
  if (rootEl) {
    if (vp) {
      rootEl.style.width = `${vp.width}px`;
      rootEl.style.height = `${vp.height}px`;
      rootEl.style.boxShadow = '0 0 0 1px rgba(148,163,184,0.4), 0 20px 50px rgba(0,0,0,0.35)';
    } else {
      rootEl.style.width = '';
      rootEl.style.height = '';
      rootEl.style.boxShadow = '';
    }
  }

  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        if (rule instanceof CSSMediaRule) {
          if (!origMediaTextMap.has(rule)) {
            origMediaTextMap.set(rule, rule.media.mediaText || rule.conditionText);
          }
          const orig = origMediaTextMap.get(rule)!;
          if (vp) {
            rule.media.mediaText = doesMediaRuleMatchWidth(orig, vp.width) ? 'all' : 'not all';
          } else {
            rule.media.mediaText = orig;
          }
        }
      }
    } catch {
      // Ignore cross-origin stylesheets
    }
  }

  window.dispatchEvent(new Event('resize'));
  if (ctx.mapRef.current) {
    ctx.mapRef.current.resize();
    await pumpMapFrames(ctx.mapRef.current, 300);
  }
}

function sanitizeCssRuleText(cssText: string, vw: number, vh: number): string {
  return cssText
    .replace(/url\((['"]?)https?:\/\/[^)]+\1\)/gi, 'none')
    .replace(/(\d+(?:\.\d+)?)d?vh\b/g, (_, n) => `${Math.round((Number(n) * vh) / 100)}px`)
    .replace(/(\d+(?:\.\d+)?)d?vw\b/g, (_, n) => `${Math.round((Number(n) * vw) / 100)}px`)
    .replace(/env\(safe-area-inset-[a-z]+(?:,\s*[^)]+)?\)/gi, '0px');
}

function collectSafeCss(vw: number, vh: number): string {
  const chunks: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        if (rule instanceof CSSMediaRule) {
          const orig = origMediaTextMap.get(rule) || rule.conditionText || rule.media.mediaText;
          if (doesMediaRuleMatchWidth(orig, vw)) {
            for (const inner of Array.from(rule.cssRules)) {
              chunks.push(sanitizeCssRuleText(inner.cssText, vw, vh));
            }
          }
        } else {
          chunks.push(sanitizeCssRuleText(rule.cssText, vw, vh));
        }
      }
    } catch {
      // Ignore cross-origin stylesheets if any
    }
  }
  chunks.push('*, *::before, *::after { animation: none !important; transition: none !important; }');
  return chunks.join('\n');
}

function syncFormStateToClone(origRoot: Element, cloneRoot: Element) {
  const origInputs = origRoot.querySelectorAll('input, select, textarea, details');
  const cloneInputs = cloneRoot.querySelectorAll('input, select, textarea, details');
  for (let i = 0; i < origInputs.length; i++) {
    const orig = origInputs[i];
    const clone = cloneInputs[i];
    if (!clone) continue;
    if (orig instanceof HTMLInputElement && clone instanceof HTMLInputElement) {
      clone.setAttribute('value', orig.value);
      if (orig.checked) clone.setAttribute('checked', 'checked');
      else clone.removeAttribute('checked');
    } else if (orig instanceof HTMLSelectElement && clone instanceof HTMLSelectElement) {
      const options = clone.querySelectorAll('option');
      options.forEach((opt, idx) => {
        if (idx === orig.selectedIndex) opt.setAttribute('selected', 'selected');
        else opt.removeAttribute('selected');
      });
    } else if (orig instanceof HTMLDetailsElement && clone instanceof HTMLDetailsElement) {
      if (orig.open) clone.setAttribute('open', '');
      else clone.removeAttribute('open');
    }
  }
}

async function captureCompositeScreenshot(ctx: McpBridgeContext): Promise<{
  dataUrl: string;
  width: number;
  height: number;
}> {
  const width = simulatedViewport?.width || window.innerWidth;
  const height = simulatedViewport?.height || window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = Math.round(width * dpr);
  outCanvas.height = Math.round(height * dpr);
  const outCtx = outCanvas.getContext('2d')!;
  outCtx.scale(dpr, dpr);

  // Fill background
  const theme = document.documentElement.getAttribute('data-theme');
  outCtx.fillStyle = theme === 'dark' ? '#0f172a' : '#f8fafc';
  outCtx.fillRect(0, 0, width, height);

  // 1. Draw MapLibre WebGL canvas
  const map = ctx.mapRef.current;
  if (map) {
    if (document.hidden) {
      try {
        map.triggerRepaint();
        (map as any)._renderTaskQueue?.run?.();
        (map as any)._render?.(performance.now());
      } catch {
        // ignore
      }
      await nextTurn();
    } else {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 300);
        map.once('render', () => {
          clearTimeout(timer);
          resolve();
        });
        map.triggerRepaint();
      });
    }
    const mapCanvas = map.getCanvas();
    outCtx.drawImage(mapCanvas, 0, 0, width, height);
  }

  // 2. Render DOM UI overlays (controls panel, route info drawer, markers, map controls) via SVG foreignObject
  const bodyClone = document.body.cloneNode(true) as HTMLBodyElement;
  syncFormStateToClone(document.body, bodyClone);

  // Remove WebGL canvas and script elements from clone so map shows through underneath
  bodyClone.querySelectorAll('canvas.maplibregl-canvas, script').forEach((el) => el.remove());
  bodyClone.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (/^https?:\/\//i.test(src)) img.remove();
  });
  bodyClone.style.background = 'transparent';
  bodyClone.style.margin = '0';
  bodyClone.style.width = `${width}px`;
  bodyClone.style.height = `${height}px`;
  const rootClone = bodyClone.querySelector('#root') as HTMLElement | null;
  if (rootClone) {
    rootClone.style.background = 'transparent';
    rootClone.style.width = `${width}px`;
    rootClone.style.height = `${height}px`;
    rootClone.style.boxShadow = 'none';
  }
  const mapClone = bodyClone.querySelector('#map') as HTMLElement | null;
  if (mapClone) mapClone.style.background = 'transparent';

  const cssText = collectSafeCss(width, height).replace(/\]\]>/g, '');
  const htmlTheme = document.documentElement.getAttribute('data-theme') || 'light';
  const serializedBody = new XMLSerializer().serializeToString(bodyClone);

  const svgMarkup = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" data-theme="${htmlTheme}">
    <style><![CDATA[${cssText}]]></style>
    <foreignObject x="0" y="0" width="${width}" height="${height}">
      ${serializedBody}
    </foreignObject>
  </svg>`;

  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgMarkup)}`;
  await new Promise<void>((resolve) => {
    const img = new Image();
    img.onload = () => {
      outCtx.drawImage(img, 0, 0, width, height);
      resolve();
    };
    img.onerror = (err) => {
      console.warn('[MCP screenshot overlay error]', err);
      resolve();
    };
    img.src = svgUrl;
  });

  return {
    dataUrl: outCanvas.toDataURL('image/png'),
    width,
    height,
  };
}

const activeCtxRef: { current: McpBridgeContext | null } =
  (window as any).__rsrouterMcpCtxRef || ((window as any).__rsrouterMcpCtxRef = { current: null });

async function handleMcpCommand(payload: {
  id: string;
  command: string;
  args?: Record<string, any>;
}) {
  const hot = import.meta.hot;
  if (!hot) return;
  const { id, command, args = {} } = payload;

  try {
    if (!activeCtxRef.current) {
      const rootText = document.getElementById('root')?.innerText?.slice(0, 600) || '';
      throw new Error(`App context not mounted yet${rootText ? `: ${rootText}` : ''}`);
    }
    const ctxRef = activeCtxRef as { current: McpBridgeContext };
    let result: any;

    if (command === 'get_state') {
      result = buildStateSnapshot(ctxRef.current);
    } else if (command === 'set_route') {
      const r = ctxRef.current.routing;
      if (args.profile) {
        r.setProfile(args.profile as ProfileName);
      }
      if (Array.isArray(args.avoidAreas)) {
        r.setAvoidAreas(
          args.avoidAreas.map((a: AvoidArea) => ({
            lat: Number(a.lat),
            lon: Number(a.lon),
            radius: Number(a.radius || 50),
            weight: a.weight !== undefined ? Number(a.weight) : undefined,
          })),
        );
      }
      if (Array.isArray(args.waypoints)) {
        const wps: LatLon[] = [];
        for (const w of args.waypoints) {
          if (w.query || (w.name && (w.lat === undefined || w.lon === undefined))) {
            const q = String(w.query || w.name);
            const places = await searchPlaces(q, { lat: 51.5, lon: -0.12 }, 3);
            if (places.length === 0) {
              throw new Error(`Could not geocode place query: ${q}`);
            }
            wps.push({
              lat: Number(places[0].lat.toFixed(5)),
              lon: Number(places[0].lon.toFixed(5)),
              name: places[0].name || q,
            });
          } else {
            wps.push({
              lat: Number(w.lat),
              lon: Number(w.lon),
              name: w.name ? String(w.name) : undefined,
            });
          }
        }
        r.setWaypoints(wps, true, args.fitBounds !== false);
      }
      if (typeof args.alternativeIdx === 'number') {
        r.selectAlternative(args.alternativeIdx);
      }
      if (args.waitForRoute !== false) {
        await waitForRoutingIdle(ctxRef);
      }
      result = buildStateSnapshot(ctxRef.current);
    } else if (command === 'interact') {
      const { action } = args;
      const cur = ctxRef.current;
      let waitsForRoute = false;

      switch (action) {
        case 'add_waypoint':
          cur.routing.addWaypoint(
            { lat: Number(args.lat), lon: Number(args.lon), name: args.name },
            args.mode || 'append',
          );
          waitsForRoute = true;
          break;
        case 'move_waypoint':
          cur.routing.moveWaypoint(Number(args.index), {
            lat: Number(args.lat),
            lon: Number(args.lon),
          });
          waitsForRoute = true;
          break;
        case 'remove_waypoint':
          cur.routing.removeWaypoint(Number(args.index));
          waitsForRoute = true;
          break;
        case 'rename_waypoint':
          cur.routing.renameWaypoint(Number(args.index), String(args.name || ''));
          break;
        case 'reverse_route':
          cur.routing.reverseRoute();
          waitsForRoute = true;
          break;
        case 'clear_route':
          cur.routing.clearRoute();
          break;
        case 'add_avoid_area':
          cur.routing.addAvoidArea(
            { lat: Number(args.lat), lon: Number(args.lon) },
            args.radius ? Number(args.radius) : undefined,
          );
          waitsForRoute = true;
          break;
        case 'remove_avoid_area':
          cur.routing.removeAvoidArea(Number(args.index));
          waitsForRoute = true;
          break;
        case 'clear_avoid_areas':
          cur.routing.clearAvoidAreas();
          waitsForRoute = true;
          break;
        case 'select_alternative':
          cur.routing.selectSlotAlternative(
            typeof args.slotIdx === 'number' ? args.slotIdx : 0,
            Number(args.alternativeIdx),
          );
          waitsForRoute = true;
          break;
        case 'add_profile_slot':
          cur.routing.addProfileSlot(args.profile as ProfileName | undefined);
          waitsForRoute = true;
          break;
        case 'remove_profile_slot':
          cur.routing.removeProfileSlot(typeof args.slotIdx === 'number' ? args.slotIdx : 1);
          break;
        case 'set_slot_profile':
          cur.routing.setSlotProfile(
            typeof args.slotIdx === 'number' ? args.slotIdx : 0,
            args.profile as ProfileName,
          );
          waitsForRoute = true;
          break;
        case 'hover_route_distance': {
          const route = cur.routing.currentRoute;
          if (args.distanceMeters === null || args.distanceMeters === undefined || !route) {
            cur.ui.setHoverPosition(null);
          } else {
            const coords = (route.features[0]?.geometry as GeoJSON.LineString)?.coordinates || [];
            const prof = buildProfile(coords);
            if (prof.coords.length > 0) {
              const idx = nearestIndex(prof.dist, Number(args.distanceMeters));
              const pt = prof.coords[idx];
              cur.ui.setHoverPosition({ lon: pt[0], lat: pt[1] });
            }
          }
          break;
        }
        case 'highlight_category': {
          if (!args.category || args.kind === 'clear') {
            cur.ui.setSegmentHighlight(null);
          } else {
            const hl = buildCategorySegmentHighlight(
              cur.routing.currentRoute,
              args.kind === 'road' ? 'road' : 'surface',
              String(args.category),
            );
            cur.ui.setSegmentHighlight(hl);
          }
          break;
        }
        case 'toggle_controls':
          cur.ui.setIsControlsCollapsed((prev) =>
            typeof args.collapsed === 'boolean' ? args.collapsed : !prev,
          );
          break;
        case 'toggle_route_info':
          cur.ui.setIsRouteInfoCollapsed((prev) =>
            typeof args.collapsed === 'boolean' ? args.collapsed : !prev,
          );
          break;
        case 'toggle_settings':
          cur.ui.setIsSettingsOpen((prev) => (typeof args.open === 'boolean' ? args.open : !prev));
          break;
        case 'toggle_about':
          cur.ui.setIsAboutOpen((prev) => (typeof args.open === 'boolean' ? args.open : !prev));
          break;
        case 'set_settings':
          if (args.units) cur.settings.changeUnits(args.units as Units);
          if (args.theme) cur.settings.changeTheme(args.theme as Theme);
          if (args.basemap) cur.settings.changeBasemap(args.basemap as Basemap);
          if (typeof args.offlineMode === 'boolean') {
            cur.offline.setOfflineMode(args.offlineMode);
          }
          break;
        case 'undo':
          cur.routing.undo();
          waitsForRoute = true;
          break;
        case 'redo':
          cur.routing.redo();
          waitsForRoute = true;
          break;
        case 'set_viewport':
          if (args.width && args.height) {
            await applySimulatedViewport(cur, {
              width: Number(args.width),
              height: Number(args.height),
            });
          } else {
            await applySimulatedViewport(cur, null);
          }
          break;
        case 'import_gpx': {
          const gpxXml = String(args.gpxContent || args.gpxXml || '');
          if (!gpxXml) throw new Error('import_gpx requires gpxContent or gpxXml');
          cur.routing.importGpxContent(
            gpxXml,
            typeof args.toleranceM === 'number' ? args.toleranceM : 20,
          );
          waitsForRoute = true;
          break;
        }
        case 'click_selector': {
          const el = document.querySelector(String(args.selector)) as HTMLElement | null;
          if (!el) throw new Error(`Element not found for selector: ${args.selector}`);
          el.click();
          waitsForRoute = true;
          break;
        }
        default:
          throw new Error(`Unknown interact action: ${action}`);
      }

      if (waitsForRoute && args.waitForRoute !== false) {
        await waitForRoutingIdle(ctxRef);
        if (ctxRef.current.mapRef.current) {
          await pumpMapFrames(ctxRef.current.mapRef.current, 500);
        }
      } else {
        await sleep(80);
      }
      result = buildStateSnapshot(ctxRef.current);
    } else if (command === 'compare_gpx') {
      if (args.gpxContent) {
        ctxRef.current.routing.importGpxContent(String(args.gpxContent));
        await waitForRoutingIdle(ctxRef);
      }
      result = buildStateSnapshot(ctxRef.current);
    } else if (command === 'map_camera') {
      const map = ctxRef.current.mapRef.current;
      if (!map) throw new Error('Map instance is not initialized');
      if (args.fitBounds) {
        ctxRef.current.routing.triggerFitBounds();
      } else if (args.center) {
        map.jumpTo({
          center: [Number(args.center.lon), Number(args.center.lat)],
          zoom: typeof args.zoom === 'number' ? args.zoom : map.getZoom(),
        });
      }
      await pumpMapFrames(map, 600);
      result = buildStateSnapshot(ctxRef.current);
    } else if (command === 'screenshot') {
      if (ctxRef.current.mapRef.current) {
        await pumpMapFrames(ctxRef.current.mapRef.current, 400);
      }
      await sleep(60);
      result = await captureCompositeScreenshot(ctxRef.current);
    } else if (command === 'journey_log') {
      if (args.clear) {
        journeyLog.length = 0;
      }
      result = { entries: [...journeyLog] };
    } else {
      throw new Error(`Unsupported MCP command: ${command}`);
    }

    if (command !== 'get_state' && command !== 'screenshot' && command !== 'journey_log') {
      const snap = buildStateSnapshot(ctxRef.current);
      journeyLog.push({
        timestamp: new Date().toISOString(),
        command,
        args,
        waypointCount: snap.waypoints.length,
        hasRoute: Boolean(snap.routeSummary),
        status: snap.status,
      });
    }

    hot.send('mcp:result', { id, ok: true, result });
  } catch (err: any) {
    hot.send('mcp:result', {
      id,
      ok: false,
      error: err?.message || String(err),
    });
  }
}

if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.on('mcp:command', handleMcpCommand);
  import.meta.hot.dispose(() => {
    import.meta.hot?.off?.('mcp:command', handleMcpCommand);
  });
  import.meta.hot.send('mcp:ready', { url: window.location.href });
}

export function useMcpBridge(ctx: McpBridgeContext) {
  if (import.meta.hot) {
    activeCtxRef.current = ctx;
  }
}

