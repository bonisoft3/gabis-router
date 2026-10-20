import {
  AVOID_RADIUS_PRESETS,
  MAX_ROUTE_SLOTS,
  PROFILE_INFO,
  PROFILE_ORDER,
  ROUTE_SLOT_COLORS,
  waypointKind,
  waypointLabel,
  type AvoidArea,
  type Basemap,
  type BreakdownRowModel,
  type ComputedElevationModel,
  type LatLon,
  type ProfileName,
  type RouteSlotState,
  type SegmentHighlight,
  type Theme,
  type Units,
  type WorkerMessage,
} from '../types.ts';
import {
  buildElevationChartModel,
  buildSurfaceBreakdownModel,
  computeHoverReadout,
  formatDistance,
  formatDuration,
  formatElevation,
  formatSpeed,
  HistoryStack,
  routeToGpx,
} from './route-domain.js';
import {
  getBasemap,
  getCustomThunderforestKey,
  getThunderforestKey,
  onBasemapChange,
  setBasemap,
  setThunderforestKey,
} from '../tile-picker.ts';
import {
  reverseGeocode,
  searchPlaces,
  type GeocodePlace,
} from '../geocoding.ts';
import { buildProfile, legIndexAt, parseCoordinateInput } from '../utils/geo.ts';
import { getShareableRouteUrl, isNativePlatform } from '../platform.ts';
import { useMcpBridge, type StateSetter } from '../mcp-bridge.ts';
import { DEFAULT_AVOID_RADIUS_M, MapController } from './map-controller.ts';
import { OfflineController } from './offline-controller.ts';

const STORAGE_KEY = 'rsrouter_route';
const UNITS_STORAGE_KEY = 'rsrouter_units';
const THEME_STORAGE_KEY = 'rsrouter_theme';
const MAX_UNDO = 50;

function readInitialUnits(): Units {
  const saved = localStorage.getItem(UNITS_STORAGE_KEY);
  if (saved === 'metric' || saved === 'imperial') return saved;
  const lang = typeof navigator !== 'undefined' ? navigator.language : '';
  return ['en-US', 'en-GB'].includes(lang) ? 'imperial' : 'metric';
}

function readInitialTheme(): Theme {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  if (saved === 'auto' || saved === 'light' || saved === 'dark') return saved;
  return 'auto';
}

function applyDocumentTheme(theme: Theme) {
  const dark =
    theme === 'dark' ||
    (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#0f172a' : '#1e293b');
}

async function downloadGpxFile(content: string, filename: string): Promise<void> {
  if (typeof window !== 'undefined' && window.AndroidNative?.exportGpx) {
    if (window.AndroidNative.exportGpx(content, filename)) {
      return;
    }
  }
  if (
    typeof window !== 'undefined' &&
    window.Capacitor?.isNativePlatform?.() &&
    typeof navigator !== 'undefined' &&
    navigator.share
  ) {
    try {
      const file = new File([content], filename, { type: 'application/gpx+xml' });
      if (!navigator.canShare || navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return;
      }
    } catch (err: any) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
    }
  }
  const blob = new Blob([content], { type: 'application/gpx+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

interface RouteHistorySnapshot {
  waypoints: LatLon[];
  avoidAreas: AvoidArea[];
}

interface RouteStats {
  distance: string;
  time: string;
  ascent: string;
  descent: string;
  avgSpeed: string;
}

function validPoint(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

function validProfile(p: string | undefined): p is ProfileName {
  return !!p && p in PROFILE_INFO;
}

function parseProfilesParam(raw: string | undefined): ProfileName[] | undefined {
  if (!raw) return undefined;
  const decoded = decodeURIComponent(raw);
  const list = decoded
    .split(',')
    .map((s) => s.trim())
    .filter(validProfile)
    .slice(0, MAX_ROUTE_SLOTS);
  return list.length > 0 ? list : undefined;
}

function parseHash(): { waypoints: LatLon[]; profiles?: ProfileName[]; avoidAreas: AvoidArea[] } | null {
  const raw = /(?:^#|&)r=([^&]*)/.exec(location.hash)?.[1];
  const rawNogos = /(?:^#|&)nogos=([^&]*)/.exec(location.hash)?.[1];
  const rawProfile = /(?:^#|&)p=([^&]*)/.exec(location.hash)?.[1];
  if (!raw && !rawNogos && !rawProfile) return null;
  const points: LatLon[] = [];
  if (raw) {
    for (const pair of raw.split(';')) {
      const [lat, lon] = pair.split(',').map(Number);
      if (validPoint(lat, lon)) {
        points.push({ lat, lon });
      }
    }
  }
  const parsedAvoidAreas: AvoidArea[] = [];
  if (rawNogos) {
    for (const item of decodeURIComponent(rawNogos).split(';')) {
      const parts = item.split(',').map(Number);
      if (parts.length >= 3 && validPoint(parts[1], parts[0])) {
        parsedAvoidAreas.push({
          lon: parts[0],
          lat: parts[1],
          radius: Math.max(10, parts[2] || DEFAULT_AVOID_RADIUS_M),
          weight: parts[3],
        });
      }
    }
  }
  return {
    waypoints: points,
    profiles: parseProfilesParam(rawProfile),
    avoidAreas: parsedAvoidAreas,
  };
}

function loadSavedRoute(): { waypoints: LatLon[]; profiles?: ProfileName[]; avoidAreas?: AvoidArea[] } | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      let profiles: ProfileName[] | undefined;
      if (Array.isArray(parsed.profiles)) {
        const filtered = parsed.profiles.filter(validProfile).slice(0, MAX_ROUTE_SLOTS);
        if (filtered.length > 0) profiles = filtered;
      }
      if (!profiles && validProfile(parsed.profile)) {
        profiles = [parsed.profile];
      }
      return {
        waypoints: Array.isArray(parsed.waypoints)
          ? parsed.waypoints.filter((w: any) => w && validPoint(Number(w.lat), Number(w.lon)))
          : [],
        profiles,
        avoidAreas: Array.isArray(parsed.avoidAreas)
          ? parsed.avoidAreas.filter((a: any) => a && validPoint(Number(a.lat), Number(a.lon)))
          : [],
      };
    }
    return null;
  } catch {
    return null;
  }
}

function mergeSavedWaypointNames(waypoints: LatLon[], saved: LatLon[] | undefined): LatLon[] {
  if (!saved || saved.length === 0) return waypoints;
  return waypoints.map((w) => {
    if (w.name) return w;
    const match = saved.find(
      (s) => s.name && Math.abs(s.lat - w.lat) < 1e-5 && Math.abs(s.lon - w.lon) < 1e-5,
    );
    return match ? { ...w, name: match.name } : w;
  });
}

function parseRouteStats(route: GeoJSON.FeatureCollection | null, units: Units): RouteStats | null {
  if (!route || !route.features || !route.features.length) return null;
  const feat = route.features[0];
  const props = (feat.properties || {}) as Record<string, any>;
  const coords = (feat.geometry as GeoJSON.LineString | undefined)?.coordinates || [];
  const prof = buildProfile(coords);

  const len = Number(props['track-length'] || 0);
  const sec = Number(props['total-time'] || 0);
  const asc = Number(props['filtered ascend'] || 0);
  const net = prof.ele.length > 0 ? prof.ele[prof.ele.length - 1] - prof.ele[0] : 0;
  const desc = Math.max(0, asc - net);

  return {
    distance: formatDistance(len, units),
    time: formatDuration(sec),
    ascent: formatElevation(asc, units),
    descent: formatElevation(desc, units),
    avgSpeed: formatSpeed(len, sec, units),
  };
}

async function syncTableRows(store: any, table: string, rows: Record<string, any>[]) {
  if (!store) return;
  const existing: Record<string, any>[] = (await store.query(table, null, {})) ?? [];
  const nextIds = new Set(rows.map((r) => String(r.id)));
  const toDrop = existing.map((r) => r.id).filter((id) => !nextIds.has(String(id)));
  if (toDrop.length > 0) {
    await store.drop(table, toDrop);
  }
  if (rows.length > 0) {
    await store.write(
      table,
      rows.map((row) => ({ key: row.id, row })),
    );
  }
}

export function installRouterHost() {
  (globalThis as any).__rsrouterMountHost = (screen: HTMLElement, env: { signal?: AbortSignal }) => {
    const store = (globalThis as any).__prontoStore;

    let units: Units = readInitialUnits();
    let theme: Theme = readInitialTheme();
    applyDocumentTheme(theme);
    let basemap: Basemap = getBasemap();
    let thunderforestKey: string = getThunderforestKey();

    const setUnits = (next: Units) => {
      if (units === next) return;
      units = next;
      localStorage.setItem(UNITS_STORAGE_KEY, next);
      syncAll();
    };

    const setTheme = (next: Theme) => {
      if (theme === next) return;
      theme = next;
      localStorage.setItem(THEME_STORAGE_KEY, next);
      applyDocumentTheme(next);
      syncAll();
    };

    let slots: RouteSlotState[] = [
      { profile: 'fastbike-lowtraffic', alternativeIdx: 0, route: null, isRouting: false },
    ];
    let waypoints: LatLon[] = [];
    let avoidAreas: AvoidArea[] = [];
    let status = 'Click on the map or search to set start and end points.';
    let isError = false;
    let canUndo = false;
    let canRedo = false;

    const history = new HistoryStack<RouteHistorySnapshot>(MAX_UNDO);
    let activeSlotRouteId: Array<string | null> = [null];
    let activeImportId: string | null = null;
    let initCompleted = false;
    let routeCounter = 0;
    let requestedSlotAlt: number[] = [0];
    let shownSlotAlt: number[] = [0];

    let geocodingIds = new Set<number>();
    let editingWpIdx: number | null = null;
    let editWpValue = '';

    let isControlsCollapsed = false;
    let isRouteInfoCollapsed = false;
    let collapsedSlots: Record<number, boolean> = {};
    let isSettingsOpen = false;
    let isAboutOpen = false;
    let shareCopied = false;
    let hoverPosition: { lat: number; lon: number } | null = null;
    let segmentHighlight: SegmentHighlight | null = null;

    // Place search state
    let searchQuery = '';
    let searchResults: GeocodePlace[] = [];
    let isSearchOpen = false;
    let searchStatusText: string | null = null;
    let activeSearchIdx = -1;
    let searchDebounceTimer: number | null = null;

    const elevationModels = new Map<number, ComputedElevationModel>();
    const breakdownModels = new Map<number, BreakdownRowModel[]>();
    const activeHighlights = new Map<number, { rowTitle: string; label: string } | null>();

    const worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });

    const offlineController = new OfflineController({
      onStateChange: () => syncAll(),
      onOfflineModeChange: (offline) => {
        worker.postMessage({ type: 'SET_OFFLINE_MODE', offline } satisfies WorkerMessage);
      },
      onClearWorkerGraph: (recompute = false) => {
        clearWorkerGraph(recompute);
      },
      onStatusChange: (msg) => {
        setStatusMsg(msg, false);
      },
    });

    const mapContainer = screen.querySelector('#map') as HTMLElement;
    const mapController = new MapController(
      mapContainer,
      offlineController.isOfflineMode,
      basemap,
      thunderforestKey,
      {
        onAddWaypoint: (point, action) => addWaypoint(point, action),
        onInsertWaypointAtLeg: (point, index) => insertWaypointAtLeg(point, index),
        onMoveWaypoint: (index, point) => moveWaypoint(index, point),
        onRemoveWaypoint: (index) => removeWaypoint(index),
        onRenameWaypoint: (index, name) => renameWaypoint(index, name),
        onRequestInlineRename: (index) => startInlineRename(index),
        onAddAvoidArea: (area, radius) => addAvoidArea(area, radius),
        onUpdateAvoidAreaRadius: (index, radius) => updateAvoidAreaRadius(index, radius),
        onRemoveAvoidArea: (index) => removeAvoidArea(index),
        onHoverPosition: (pos) => setHoverPosition(pos),
        onStatusChange: (msg) => setStatusMsg(msg, false),
      },
    );

    const mapRef = { current: mapController.map };

    const updateUndoRedo = () => {
      canUndo = history.canUndo();
      canRedo = history.canRedo();
    };

    const setStatusMsg = (msg: string, error = false) => {
      status = msg;
      isError = error;
      syncAll();
    };

    const saveToUrlAndStorage = (wps: LatLon[], profs: ProfileName[], avoids: AvoidArea[]) => {
      const safeProfs: ProfileName[] = profs.length > 0 ? profs : ['fastbike-lowtraffic'];
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            waypoints: wps,
            profile: safeProfs[0],
            profiles: safeProfs,
            avoidAreas: avoids,
          }),
        );
      } catch {}

      if (wps.length === 0 && avoids.length === 0) {
        window.history.replaceState(null, '', location.pathname + location.search);
        return;
      }
      const parts: string[] = [];
      if (wps.length > 0) {
        const r = wps.map((w) => `${w.lat.toFixed(5)},${w.lon.toFixed(5)}`).join(';');
        parts.push(`r=${r}`);
      }
      parts.push(`p=${safeProfs.map(encodeURIComponent).join(',')}`);
      if (avoids.length > 0) {
        const nogos = avoids
          .map(
            (a) =>
              `${a.lon.toFixed(5)},${a.lat.toFixed(5)},${Math.round(a.radius)}${
                a.weight !== undefined ? ',' + a.weight : ''
              }`,
          )
          .join(';');
        parts.push(`nogos=${encodeURIComponent(nogos)}`);
      }
      window.history.replaceState(null, '', location.pathname + location.search + '#' + parts.join('&'));
    };

    const postSlotRouteRequest = (
      slotIdx: number,
      wps: LatLon[],
      prof: ProfileName,
      avoids: AvoidArea[],
      altIdx = 0,
    ) => {
      if (wps.length < 2) return;
      const id = String(++routeCounter);
      activeSlotRouteId[slotIdx] = id;
      requestedSlotAlt[slotIdx] = altIdx;

      worker.postMessage({
        type: 'ROUTE_REQUEST',
        id,
        slotIdx,
        payload: {
          waypoints: wps,
          profile: prof,
          alternativeIdx: altIdx,
          nogos: avoids.length > 0 ? avoids : undefined,
        },
      } satisfies WorkerMessage);
    };

    const requestAllSlots = (
      wps: LatLon[],
      currentSlots: RouteSlotState[],
      avoids: AvoidArea[],
      resetAlt = true,
    ) => {
      if (wps.length < 2) {
        activeSlotRouteId = currentSlots.map(() => null);
        requestedSlotAlt = currentSlots.map(() => 0);
        shownSlotAlt = currentSlots.map(() => 0);
        slots = currentSlots.map((s) => ({
          ...s,
          alternativeIdx: 0,
          route: null,
          isRouting: false,
        }));
        isError = false;
        status =
          wps.length === 1
            ? 'Start point set. Click on the map or search to set destination.'
            : 'Click on the map or search to set start and end points.';
        syncAll();
        return;
      }

      status = 'Calculating route...';
      isError = false;

      slots = currentSlots.map((s, idx) => {
        const alt = resetAlt ? 0 : s.alternativeIdx;
        if (resetAlt) {
          requestedSlotAlt[idx] = 0;
          shownSlotAlt[idx] = 0;
        }
        return {
          ...s,
          alternativeIdx: alt,
          isRouting: true,
        };
      });
      syncAll();

      slots.forEach((slot, idx) => {
        postSlotRouteRequest(idx, wps, slot.profile, avoids, slot.alternativeIdx);
      });
    };

    const resolveWaypointAddress = (idx: number, lat: number, lon: number) => {
      if (offlineController.isOfflineMode) return;
      geocodingIds.add(idx);
      syncAll();
      reverseGeocode(lat, lon)
        .then((name) => {
          const current = waypoints[idx];
          const stillSame =
            current &&
            !current.name &&
            Math.abs(current.lat - lat) <= 1e-5 &&
            Math.abs(current.lon - lon) <= 1e-5;
          if (stillSame) {
            geocodingIds.delete(idx);
            if (name) {
              renameWaypoint(idx, name, { lat, lon });
            } else {
              syncAll();
            }
          }
        })
        .catch(() => {
          const current = waypoints[idx];
          if (
            current &&
            !current.name &&
            Math.abs(current.lat - lat) <= 1e-5 &&
            Math.abs(current.lon - lon) <= 1e-5
          ) {
            geocodingIds.delete(idx);
            syncAll();
          }
        });
    };

    const geocodeUnnamedWaypoints = (wps: LatLon[]) => {
      geocodingIds.clear();
      wps.forEach((w, idx) => {
        if (!w.name) {
          resolveWaypointAddress(idx, w.lat, w.lon);
        }
      });
    };

    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const msg = e.data;
      switch (msg.type) {
        case 'STATUS': {
          const anyActive =
            activeImportId !== null || activeSlotRouteId.some((id) => id !== null);
          if (!initCompleted) {
            if (
              msg.message.startsWith('Router ready') ||
              msg.message.startsWith('Initialization failed')
            ) {
              initCompleted = true;
            }
            if (!anyActive && waypoints.length === 0) {
              status = msg.message;
              isError = msg.message.startsWith('Initialization failed');
              syncAll();
            }
          } else if (anyActive) {
            status = msg.message;
            isError = false;
            syncAll();
          }
          break;
        }
        case 'ROUTE_SUCCESS': {
          const slotIdx = activeSlotRouteId.indexOf(msg.id);
          if (slotIdx === -1) break;
          activeSlotRouteId[slotIdx] = null;
          const altIdx = requestedSlotAlt[slotIdx] ?? 0;
          shownSlotAlt[slotIdx] = altIdx;

          slots = slots.map((s, idx) =>
            idx === slotIdx
              ? { ...s, route: msg.payload, alternativeIdx: altIdx, isRouting: false }
              : s,
          );

          const stillRouting = slots.some((s) => s.isRouting);
          if (!stillRouting) {
            isError = false;
            status = '';
          }
          syncAll();
          break;
        }
        case 'IMPORT_GPX_SUCCESS': {
          if (msg.id !== activeImportId) break;
          activeImportId = null;
          if (waypoints.length > 0 || avoidAreas.length > 0) {
            history.record({
              waypoints: waypoints.map((w) => ({ ...w })),
              avoidAreas: avoidAreas.map((a) => ({ ...a })),
            });
            updateUndoRedo();
          }
          const newWps = msg.payload.waypoints;
          waypoints = newWps;
          avoidAreas = [];

          slots = slots.map((s, idx) => {
            shownSlotAlt[idx] = 0;
            requestedSlotAlt[idx] = 0;
            if (idx === 0) {
              activeSlotRouteId[0] = null;
              return { ...s, alternativeIdx: 0, route: msg.payload.route, isRouting: false };
            }
            return { ...s, alternativeIdx: 0, isRouting: newWps.length >= 2 };
          });

          saveToUrlAndStorage(
            newWps,
            slots.map((s) => s.profile),
            [],
          );
          geocodeUnnamedWaypoints(newWps);
          syncAll();
          mapController.triggerFitBounds();

          if (newWps.length >= 2 && slots.length > 1) {
            for (let idx = 1; idx < slots.length; idx++) {
              postSlotRouteRequest(idx, newWps, slots[idx].profile, [], 0);
            }
          } else {
            isError = false;
            status = '';
            syncAll();
          }
          break;
        }
        case 'ROUTE_ERROR': {
          if (msg.id === activeImportId) {
            activeImportId = null;
            slots = slots.map((s) => ({ ...s, isRouting: false }));
            status = `Routing error: ${msg.error}`;
            isError = true;
            syncAll();
            break;
          }
          const slotIdx = activeSlotRouteId.indexOf(msg.id);
          if (slotIdx === -1) break;
          activeSlotRouteId[slotIdx] = null;

          const reqAlt = requestedSlotAlt[slotIdx] ?? 0;
          const prevAlt = shownSlotAlt[slotIdx] ?? 0;
          const currentSlot = slots[slotIdx];

          if (reqAlt > 0 && currentSlot?.route) {
            const failedAlt = reqAlt + 1;
            requestedSlotAlt[slotIdx] = prevAlt;
            slots = slots.map((s, idx) =>
              idx === slotIdx ? { ...s, alternativeIdx: prevAlt, isRouting: false } : s,
            );
            status = `Alternative ${failedAlt} is not available for ${
              PROFILE_INFO[currentSlot.profile]?.shortLabel || currentSlot.profile
            }.`;
            isError = true;
            syncAll();
            break;
          }

          slots = slots.map((s, idx) =>
            idx === slotIdx ? { ...s, route: null, isRouting: false } : s,
          );
          status = `Routing error: ${msg.error}`;
          isError = true;
          syncAll();
          break;
        }
      }
    };

    worker.postMessage({
      type: 'SET_OFFLINE_MODE',
      offline: offlineController.isOfflineMode,
    } satisfies WorkerMessage);
    worker.postMessage({ type: 'INIT' } satisfies WorkerMessage);

    // Waypoint & Avoid mutations
    const setWaypoints = (next: LatLon[], recordUndo = true, fitMap = false) => {
      if (recordUndo) {
        history.record({
          waypoints: waypoints.map((w) => ({ ...w })),
          avoidAreas: avoidAreas.map((a) => ({ ...a })),
        });
        updateUndoRedo();
      }
      waypoints = next;
      activeHighlights.clear();
      segmentHighlight = null;
      mapController.updateSegmentHighlight(null);
      saveToUrlAndStorage(
        next,
        slots.map((s) => s.profile),
        avoidAreas,
      );
      geocodeUnnamedWaypoints(next);
      requestAllSlots(next, slots, avoidAreas, true);
      if (fitMap && next.length > 0) {
        mapController.triggerFitBounds();
      }
    };

    const setAvoidAreas = (next: AvoidArea[], recordUndo = true) => {
      if (recordUndo) {
        history.record({
          waypoints: waypoints.map((w) => ({ ...w })),
          avoidAreas: avoidAreas.map((a) => ({ ...a })),
        });
        updateUndoRedo();
      }
      avoidAreas = next;
      saveToUrlAndStorage(
        waypoints,
        slots.map((s) => s.profile),
        next,
      );
      if (waypoints.length >= 2) {
        requestAllSlots(waypoints, slots, next, true);
      } else {
        syncAll();
      }
    };

    const setSlotProfile = (slotIdx: number, nextProfile: ProfileName) => {
      if (slotIdx < 0 || slotIdx >= slots.length) return;
      requestedSlotAlt[slotIdx] = 0;
      shownSlotAlt[slotIdx] = 0;
      const hasWps = waypoints.length >= 2;
      slots = slots.map((s, idx) =>
        idx === slotIdx
          ? { ...s, profile: nextProfile, alternativeIdx: 0, isRouting: hasWps }
          : s,
      );
      saveToUrlAndStorage(
        waypoints,
        slots.map((s) => s.profile),
        avoidAreas,
      );
      if (hasWps) {
        status = 'Calculating route...';
        isError = false;
        syncAll();
        postSlotRouteRequest(slotIdx, waypoints, nextProfile, avoidAreas, 0);
      } else {
        syncAll();
      }
    };

    const setProfile = (next: ProfileName) => {
      setSlotProfile(0, next);
    };

    const addProfileSlot = (initialProfile?: ProfileName) => {
      if (slots.length >= MAX_ROUTE_SLOTS) return;
      const usedProfiles = new Set(slots.map((s) => s.profile));
      const nextProfile =
        initialProfile && validProfile(initialProfile)
          ? initialProfile
          : PROFILE_ORDER.find((p) => !usedProfiles.has(p)) || PROFILE_ORDER[0];

      const newSlotIdx = slots.length;
      const hasWps = waypoints.length >= 2;
      slots = [
        ...slots,
        {
          profile: nextProfile,
          alternativeIdx: 0,
          route: null,
          isRouting: hasWps,
        },
      ];
      activeSlotRouteId.push(null);
      requestedSlotAlt.push(0);
      shownSlotAlt.push(0);

      saveToUrlAndStorage(
        waypoints,
        slots.map((s) => s.profile),
        avoidAreas,
      );
      if (hasWps) {
        status = 'Calculating route...';
        isError = false;
        syncAll();
        postSlotRouteRequest(newSlotIdx, waypoints, nextProfile, avoidAreas, 0);
      } else {
        syncAll();
      }
    };

    const removeProfileSlot = (slotIdx: number) => {
      if (slots.length <= 1 || slotIdx < 0 || slotIdx >= slots.length) return;
      slots = slots.filter((_, idx) => idx !== slotIdx);
      activeSlotRouteId.splice(slotIdx, 1);
      requestedSlotAlt.splice(slotIdx, 1);
      shownSlotAlt.splice(slotIdx, 1);

      saveToUrlAndStorage(
        waypoints,
        slots.map((s) => s.profile),
        avoidAreas,
      );
      if (!slots.some((s) => s.isRouting)) {
        status = '';
      }
      syncAll();
    };

    const selectSlotAlternative = (slotIdx: number, altIdx: number) => {
      if (
        slotIdx < 0 ||
        slotIdx >= slots.length ||
        altIdx === shownSlotAlt[slotIdx] ||
        waypoints.length < 2
      ) {
        return;
      }
      slots = slots.map((s, idx) =>
        idx === slotIdx ? { ...s, alternativeIdx: altIdx, isRouting: true } : s,
      );
      status = 'Calculating route...';
      isError = false;
      syncAll();
      postSlotRouteRequest(slotIdx, waypoints, slots[slotIdx].profile, avoidAreas, altIdx);
    };

    const selectAlternative = (idx: number) => {
      selectSlotAlternative(0, idx);
    };

    const addWaypoint = (p: LatLon, action?: 'start' | 'end' | 'via' | 'append') => {
      let next: LatLon[];
      if (action === 'start') {
        next = waypoints.length === 0 ? [p] : [p, ...waypoints.slice(1)];
      } else if (action === 'end') {
        next = waypoints.length < 2 ? [...waypoints, p] : [...waypoints.slice(0, -1), p];
      } else if (action === 'via') {
        if (waypoints.length < 2) {
          next = [...waypoints, p];
        } else {
          const primaryRoute = slots[0]?.route;
          const coords = (
            primaryRoute?.features[0]?.geometry as GeoJSON.LineString | undefined
          )?.coordinates;
          const leg = legIndexAt(coords, waypoints, p.lon, p.lat);
          next = [...waypoints];
          next.splice(Math.max(1, leg + 1), 0, p);
        }
      } else {
        next = [...waypoints, p];
      }
      setWaypoints(next, true);
    };

    const insertWaypointAtLeg = (p: LatLon, insertIndex: number) => {
      const next = [...waypoints];
      const clampedIndex = Math.max(0, Math.min(next.length, insertIndex));
      next.splice(clampedIndex, 0, p);
      setWaypoints(next, true);
    };

    const moveWaypoint = (index: number, p: LatLon) => {
      if (!waypoints[index]) return;
      const next = waypoints.map((w, i) => (i === index ? { lat: p.lat, lon: p.lon } : w));
      setWaypoints(next, true);
    };

    const removeWaypoint = (index: number) => {
      const next = waypoints.filter((_, i) => i !== index);
      setWaypoints(next, true);
    };

    const renameWaypoint = (
      index: number,
      name: string,
      expectedCoords?: { lat: number; lon: number },
    ) => {
      const current = waypoints[index];
      if (!current) return;
      if (expectedCoords) {
        if (
          current.name ||
          Math.abs(current.lat - expectedCoords.lat) > 1e-5 ||
          Math.abs(current.lon - expectedCoords.lon) > 1e-5
        ) {
          return;
        }
      }
      const trimmed = name.trim() || undefined;
      editingWpIdx = null;
      if (current.name === trimmed) {
        syncAll();
        return;
      }
      waypoints = waypoints.map((w, i) => (i === index ? { ...w, name: trimmed } : w));
      const profs = slots.map((s) => s.profile);
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            waypoints,
            profile: profs[0],
            profiles: profs,
            avoidAreas,
          }),
        );
      } catch {}
      syncAll();
    };

    const startInlineRename = (index: number) => {
      const wp = waypoints[index];
      if (!wp) return;
      editingWpIdx = index;
      editWpValue = wp.name || '';
      syncAll();
      setTimeout(() => {
        const inp = screen.querySelector(
          `.wp-rename-input[data-wp-idx="${index}"]`,
        ) as HTMLInputElement | null;
        inp?.focus();
        inp?.select();
      }, 30);
    };

    const reorderWaypoints = (fromIndex: number, toIndex: number) => {
      if (toIndex < 0 || toIndex >= waypoints.length) return;
      const next = [...waypoints];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      setWaypoints(next, true);
    };

    const reverseRoute = () => {
      if (waypoints.length < 2) return;
      const next = [...waypoints].reverse();
      setWaypoints(next, true);
    };

    const addAvoidArea = (p: LatLon, radius = DEFAULT_AVOID_RADIUS_M) => {
      const next = [...avoidAreas, { lat: p.lat, lon: p.lon, radius }];
      setAvoidAreas(next, true);
    };

    const updateAvoidAreaRadius = (index: number, radius: number) => {
      if (!avoidAreas[index]) return;
      const next = avoidAreas.map((a, i) =>
        i === index ? { ...a, radius: Math.max(10, radius) } : a,
      );
      setAvoidAreas(next, true);
    };

    const removeAvoidArea = (index: number) => {
      const next = avoidAreas.filter((_, i) => i !== index);
      setAvoidAreas(next, true);
    };

    const clearAvoidAreas = () => {
      if (avoidAreas.length === 0) return;
      setAvoidAreas([], true);
    };

    const clearRoute = () => {
      if (waypoints.length === 0 && avoidAreas.length === 0) return;
      history.record({
        waypoints: waypoints.map((w) => ({ ...w })),
        avoidAreas: avoidAreas.map((a) => ({ ...a })),
      });
      updateUndoRedo();
      activeImportId = null;
      activeSlotRouteId = slots.map(() => null);
      requestedSlotAlt = slots.map(() => 0);
      shownSlotAlt = slots.map(() => 0);

      slots = slots.map((s) => ({
        ...s,
        alternativeIdx: 0,
        route: null,
        isRouting: false,
      }));
      waypoints = [];
      avoidAreas = [];
      isError = false;
      activeHighlights.clear();
      segmentHighlight = null;
      mapController.updateSegmentHighlight(null);
      saveToUrlAndStorage(
        [],
        slots.map((s) => s.profile),
        [],
      );
      status = 'Route cleared.';
      syncAll();
    };

    const undo = () => {
      const currentSnap: RouteHistorySnapshot = {
        waypoints: waypoints.map((w) => ({ ...w })),
        avoidAreas: avoidAreas.map((a) => ({ ...a })),
      };
      const prev = history.undo(currentSnap);
      if (!prev) return;
      waypoints = prev.waypoints;
      avoidAreas = prev.avoidAreas;
      updateUndoRedo();
      saveToUrlAndStorage(
        prev.waypoints,
        slots.map((s) => s.profile),
        prev.avoidAreas,
      );
      requestAllSlots(prev.waypoints, slots, prev.avoidAreas, true);
    };

    const redo = () => {
      const currentSnap: RouteHistorySnapshot = {
        waypoints: waypoints.map((w) => ({ ...w })),
        avoidAreas: avoidAreas.map((a) => ({ ...a })),
      };
      const next = history.redo(currentSnap);
      if (!next) return;
      waypoints = next.waypoints;
      avoidAreas = next.avoidAreas;
      updateUndoRedo();
      saveToUrlAndStorage(
        next.waypoints,
        slots.map((s) => s.profile),
        next.avoidAreas,
      );
      requestAllSlots(next.waypoints, slots, next.avoidAreas, true);
    };

    const clearWorkerGraph = (recompute = false) => {
      worker.postMessage({ type: 'CLEAR_GRAPH' } satisfies WorkerMessage);
      if (recompute && waypoints.length >= 2) {
        requestAllSlots(waypoints, slots, avoidAreas, false);
      }
    };

    const importGpxContent = (gpxXml: string, toleranceM = 20) => {
      status = 'Matching GPX to road network...';
      isError = false;
      slots = slots.map((s, idx) => ({
        ...s,
        isRouting: idx === 0 ? true : s.isRouting,
      }));
      const id = String(++routeCounter);
      activeImportId = id;
      activeSlotRouteId = slots.map(() => null);
      syncAll();

      worker.postMessage({
        type: 'IMPORT_GPX_REQUEST',
        id,
        payload: {
          gpxXml,
          profile: slots[0]?.profile || 'fastbike-lowtraffic',
          toleranceM,
        },
      } satisfies WorkerMessage);
    };

    const setHoverPosition: StateSetter<{ lat: number; lon: number } | null> = (next) => {
      hoverPosition = typeof next === 'function' ? next(hoverPosition) : next;
      mapController.updateHoverPosition(hoverPosition);
    };

    const setSegmentHighlight: StateSetter<SegmentHighlight | null> = (next) => {
      segmentHighlight = typeof next === 'function' ? next(segmentHighlight) : next;
      mapController.updateSegmentHighlight(segmentHighlight);
    };

    const setIsControlsCollapsed: StateSetter<boolean> = (next) => {
      isControlsCollapsed = typeof next === 'function' ? next(isControlsCollapsed) : next;
      syncAll();
    };

    const setIsRouteInfoCollapsed: StateSetter<boolean> = (next) => {
      isRouteInfoCollapsed = typeof next === 'function' ? next(isRouteInfoCollapsed) : next;
      syncAll();
    };

    const setIsSettingsOpen: StateSetter<boolean> = (next) => {
      isSettingsOpen = typeof next === 'function' ? next(isSettingsOpen) : next;
      if (isSettingsOpen) {
        offlineController.refreshStatus();
      }
      syncAll();
    };

    const setIsAboutOpen: StateSetter<boolean> = (next) => {
      isAboutOpen = typeof next === 'function' ? next(isAboutOpen) : next;
      syncAll();
    };

    // Subscribe to basemap changes
    const unsubBasemap = onBasemapChange(() => {
      basemap = getBasemap();
      syncAll();
    });

    let isSyncingStore = false;
    let syncChain = Promise.resolve();
    const syncAll = () => {
      const primaryProfile = slots[0]?.profile || 'fastbike-lowtraffic';
      const isRouting = slots.some((s) => s.isRouting);
      const isBusy = isRouting || offlineController.downloadProgress.active;

      mapController.updateStyleSettings(
        offlineController.isOfflineMode,
        basemap,
        thunderforestKey,
      );
      mapController.updateWaypoints(waypoints);
      mapController.updateAvoidAreas(avoidAreas);
      mapController.updateSlots(slots);

      // Update MCP Bridge context snapshot
      useMcpBridge({
        mapRef,
        routing: {
          slots,
          addProfileSlot,
          removeProfileSlot,
          setSlotProfile,
          selectSlotAlternative,
          profile: primaryProfile,
          setProfile,
          waypoints,
          setWaypoints,
          avoidAreas,
          setAvoidAreas,
          currentRoute: slots[0]?.route || null,
          alternativeIdx: slots[0]?.alternativeIdx ?? 0,
          selectAlternative,
          status,
          isError,
          setStatus: setStatusMsg,
          isRouting,
          canUndo,
          canRedo,
          triggerFitBounds: () => mapController.triggerFitBounds(),
          importGpxContent,
          addWaypoint,
          moveWaypoint,
          removeWaypoint,
          renameWaypoint,
          reverseRoute,
          addAvoidArea,
          removeAvoidArea,
          clearAvoidAreas,
          clearRoute,
          undo,
          redo,
        },
        offline: {
          isOfflineMode: offlineController.isOfflineMode,
          setOfflineMode: offlineController.setOfflineMode,
        },
        settings: {
          units,
          theme,
          basemap,
          thunderforestKey,
          changeUnits: setUnits,
          changeTheme: setTheme,
          changeBasemap: setBasemap,
          changeThunderforestKey: (next: string) => {
            setThunderforestKey(next);
            thunderforestKey = getThunderforestKey();
            syncAll();
          },
        },
        ui: {
          isControlsCollapsed,
          setIsControlsCollapsed,
          isRouteInfoCollapsed,
          setIsRouteInfoCollapsed,
          isSettingsOpen,
          setIsSettingsOpen,
          isAboutOpen,
          setIsAboutOpen,
          hoverPosition,
          setHoverPosition,
          segmentHighlight,
          setSegmentHighlight,
        },
      });

      const customTfKey = getCustomThunderforestKey();
      const tfInput = screen.querySelector('#input-thunderforest-key') as HTMLInputElement | null;
      if (tfInput && document.activeElement !== tfInput) {
        tfInput.value = customTfKey;
      }
      const searchInput = screen.querySelector('#input-place-search') as HTMLInputElement | null;
      if (
        searchInput &&
        document.activeElement !== searchInput &&
        searchInput.value !== searchQuery
      ) {
        searchInput.value = searchQuery;
      }

      const primaryLabel = PROFILE_INFO[primaryProfile]?.shortLabel || primaryProfile;
      const compareCount = slots.length;
      const badgeLabel = compareCount > 1 ? `${primaryLabel} +${compareCount - 1}` : primaryLabel;

      const hasRoute = slots.some((s) => Boolean(s.route));
      const anyVisibleBar = slots.some((s) => Boolean(s.route || s.isRouting));
      const isCompareMode = slots.length > 1;

      const bundleStatus = offlineController.bundleStatus;
      const dlProg = offlineController.downloadProgress;
      const mb = Math.round(bundleStatus.totalBytes / (1024 * 1024));

      const snapshotDateLabel = offlineController.snapshotDate
        ? offlineController.snapshotDate.toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          })
        : null;

      const primarySummary = PROFILE_INFO[primaryProfile]?.summary || '';
      const statusClasses = [
        'status-bar',
        isBusy ? 'is-busy' : '',
        isError ? 'is-error' : '',
      ]
        .filter(Boolean)
        .join(' ');

      const allCollapsed = isCompareMode
        ? slots.every((_, idx) => Boolean(collapsedSlots[idx]))
        : isRouteInfoCollapsed;

      const uiRow = {
        id: 'main',
        units,
        theme,
        offline_mode: offlineController.isOfflineMode ? 'true' : '',
        disable_offline_check: bundleStatus.ready ? 'false' : 'true',
        thunderforest_key: customTfKey,
        search_query: searchQuery,
        controls_class: isControlsCollapsed ? 'collapsed' : '',
        profile_badge: badgeLabel,
        hide_offline_pill: offlineController.isOfflineMode ? 'false' : 'true',
        collapse_btn_title: isControlsCollapsed ? 'Expand controls' : 'Collapse controls',
        collapse_btn_label: isControlsCollapsed ? 'Expand panel' : 'Collapse panel',
        profile_label_text: slots.length > 1 ? 'Profiles' : 'Profile',
        profile_tooltip: `${primarySummary} Profiles score every road segment by surface, traffic, hills, and cycle infrastructure. Add up to 3 profiles to compare routes side by side.`,
        hide_add_profile: slots.length < MAX_ROUTE_SLOTS ? 'false' : 'true',
        search_placeholder: offlineController.isOfflineMode
          ? 'Enter lat, lon coordinates...'
          : 'Search place, postcode, or lat, lon...',
        hide_clear_search: searchQuery ? 'false' : 'true',
        hide_search_results:
          isSearchOpen && (searchResults.length > 0 || Boolean(searchStatusText))
            ? 'false'
            : 'true',
        hide_search_status: searchStatusText ? 'false' : 'true',
        search_status: searchStatusText || '',
        disable_undo: canUndo ? 'false' : 'true',
        disable_redo: canRedo ? 'false' : 'true',
        disable_reverse: waypoints.length >= 2 ? 'false' : 'true',
        disable_clear: waypoints.length > 0 || avoidAreas.length > 0 ? 'false' : 'true',
        hide_avoid_section: avoidAreas.length > 0 ? 'false' : 'true',
        hide_avoid_header: avoidAreas.length > 1 ? 'false' : 'true',
        avoid_header_title: `Avoid Areas (${avoidAreas.length})`,
        status_class: statusClasses,
        hide_status_bar: !isBusy && !status ? 'true' : 'false',
        hide_status_spinner: isBusy ? 'false' : 'true',
        status_text: status,
        disable_share: waypoints.length >= 2 ? 'false' : 'true',
        disable_export: hasRoute ? 'false' : 'true',
        share_btn_text: shareCopied ? 'Copied' : 'Share',
        route_info_class: [
          allCollapsed ? 'collapsed' : '',
          isCompareMode ? 'multi-slot' : '',
        ]
          .filter(Boolean)
          .join(' '),
        hide_route_info: anyVisibleBar ? 'false' : 'true',
        hide_settings_modal: isSettingsOpen ? 'false' : 'true',
        offline_mode_badge_class: offlineController.isOfflineMode
          ? 'offline-badge badge-offline'
          : 'offline-badge badge-online',
        offline_mode_badge_text: offlineController.isOfflineMode ? 'Offline' : 'Online',
        offline_card_badge_class: bundleStatus.ready
          ? 'offline-mini-badge badge-ready'
          : 'offline-mini-badge badge-missing',
        offline_card_badge_text: bundleStatus.ready ? 'Ready' : 'Not Downloaded',
        offline_card_desc: bundleStatus.ready
          ? `UK and Ireland offline data ready: ${mb} MB.`
          : 'Download UK routing data and map tiles to enable offline mode.',
        hide_download_card: dlProg.active ? 'false' : 'true',
        download_msg: dlProg.message || 'Downloading...',
        download_pct: `${dlProg.percent ?? 0}%`,
        download_progress_style: `width: ${dlProg.percent ?? 0}%`,
        hide_btn_download: !bundleStatus.ready ? 'false' : 'true',
        disable_btn_download: dlProg.active ? 'true' : 'false',
        btn_download_text: dlProg.active
          ? 'Downloading...'
          : bundleStatus.hasPartialTiles
            ? 'Resume Download'
            : 'Download UK Data',
        hide_btn_delete:
          Boolean(bundleStatus.hasPartialTiles || bundleStatus.ready) ? 'false' : 'true',
        disable_btn_update: dlProg.active ? 'true' : 'false',
        btn_update_text: 'Clear cache',
        snapshot_date_text: snapshotDateLabel || 'Not cached',
        tf_key_status: customTfKey
          ? 'Custom Thunderforest API key active.'
          : thunderforestKey
            ? 'Default key active for OpenCycleMap.'
            : 'No key set. Supply a key to use OpenCycleMap.',
        hide_about_modal: isAboutOpen ? 'false' : 'true',
      };

      const slotRows = slots.map((slot, idx) => {
        const slotColor = ROUTE_SLOT_COLORS[idx] || ROUTE_SLOT_COLORS[0];
        return {
          id: `slot_${idx}`,
          slot_idx: idx,
          select_id: idx === 0 ? 'profile-select' : `profile-select-${idx}`,
          remove_btn_id: `btn-remove-profile-${idx}`,
          profile: slot.profile,
          label: PROFILE_INFO[slot.profile]?.label || slot.profile,
          summary: PROFILE_INFO[slot.profile]?.summary || '',
          color_line: slotColor.line,
          color_name: slotColor.name,
          dot_style: `background-color: ${slotColor.line}`,
          dot_title: `Route ${idx + 1} (${slotColor.name})`,
          hide_compare_chrome: slots.length > 1 ? 'false' : 'true',
        };
      });

      const searchRows = searchResults.map((r, idx) => ({
        id: `sr_${idx}`,
        idx,
        item_class: idx === activeSearchIdx ? 'search-item active' : 'search-item',
        title: r.title || r.name,
        subtitle: r.subtitle || '',
        hide_subtitle: r.subtitle ? 'false' : 'true',
      }));

      const wpRows = waypoints.map((wp, idx) => {
        const kind = waypointKind(idx, waypoints.length);
        const badgeLabel = waypointLabel(idx, waypoints.length);
        const coordStr = `${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)}`;
        const isGeocoding = !wp.name && geocodingIds.has(idx);
        const displayName = wp.name || coordStr;
        const isEditing = editingWpIdx === idx;
        const titleAttr = wp.name
          ? `${wp.name} (${coordStr}) · Click to rename`
          : `${coordStr} · Click to rename`;

        return {
          id: `wp_${idx}`,
          idx,
          badge_class: `wp-badge ${kind}`,
          badge_label: badgeLabel,
          title_attr: titleAttr,
          display_name: displayName,
          hide_loading_shimmer: isGeocoding && !isEditing ? 'false' : 'true',
          hide_name_span: isEditing || isGeocoding ? 'true' : 'false',
          edit_value: isEditing ? editWpValue : wp.name || '',
          hide_rename_input: isEditing ? 'false' : 'true',
          coord_str: coordStr,
          hide_reorder_btns: waypoints.length > 2 ? 'false' : 'true',
          disable_up: idx === 0 ? 'true' : 'false',
          disable_down: idx === waypoints.length - 1 ? 'true' : 'false',
        };
      });

      const avoidRows = avoidAreas.map((a, idx) => ({
        id: `av_${idx}`,
        idx,
        locate_title: `Center on avoid area (${a.lat.toFixed(4)}, ${a.lon.toFixed(4)})`,
        name_label: `Avoid #${idx + 1}`,
        radius_label: `${Math.round(a.radius)} m`,
      }));

      const barRows = slots
        .map((slot, slotIdx) => {
          const stats = parseRouteStats(slot.route, units);
          if (!stats && !slot.isRouting) return null;
          const slotColor = ROUTE_SLOT_COLORS[slotIdx] || ROUTE_SLOT_COLORS[0];
          const isBarCollapsed = isCompareMode
            ? Boolean(collapsedSlots[slotIdx])
            : isRouteInfoCollapsed;
          const suffix = slotIdx === 0 ? '' : `-${slotIdx}`;

          const eleModel = buildElevationChartModel(slot.route, units, slotIdx, isCompareMode);
          if (eleModel) elevationModels.set(slotIdx, eleModel);
          else elevationModels.delete(slotIdx);

          const surfModel = buildSurfaceBreakdownModel(
            slot.route,
            units,
            activeHighlights.get(slotIdx) || null,
          );
          breakdownModels.set(slotIdx, surfModel.rows);

          return {
            id: `bar_${slotIdx}`,
            slot_idx: slotIdx,
            bar_id: `route-bar-${slotIdx}`,
            card_class: isBarCollapsed ? 'route-bar-card collapsed' : 'route-bar-card',
            card_style: `--slot-color: ${slotColor.line}`,
            pill_dot_style: `background-color: ${slotColor.line}`,
            dot_title: `Route ${slotIdx + 1} (${slotColor.name})`,
            label: PROFILE_INFO[slot.profile]?.label || slot.profile,
            summary: PROFILE_INFO[slot.profile]?.summary || '',
            hide_metrics: stats ? 'false' : 'true',
            hide_loading: !stats && slot.isRouting ? 'false' : 'true',
            id_distance: `ri-distance${suffix}`,
            id_time: `ri-time${suffix}`,
            id_ascent: `ri-ascent${suffix}`,
            id_descent: `ri-descent${suffix}`,
            id_speed: `ri-speed${suffix}`,
            distance_str: stats?.distance || '—',
            time_str: stats?.time || '—',
            ascent_str: stats?.ascent || '—',
            descent_str: stats?.descent || '—',
            speed_str: stats?.avgSpeed || '—',
            alt_0_class: slot.alternativeIdx === 0 ? 'ri-alt-btn active' : 'ri-alt-btn',
            alt_1_class: slot.alternativeIdx === 1 ? 'ri-alt-btn active' : 'ri-alt-btn',
            alt_2_class: slot.alternativeIdx === 2 ? 'ri-alt-btn active' : 'ri-alt-btn',
            alt_3_class: slot.alternativeIdx === 3 ? 'ri-alt-btn active' : 'ri-alt-btn',
            id_collapse_btn: `btn-toggle-ri-collapse${suffix}`,
            collapse_title: isBarCollapsed ? 'Expand charts' : 'Collapse charts',
            hide_remove_slot: isCompareMode ? 'false' : 'true',
            id_body: `route-info-body${suffix}`,
            hide_body: isBarCollapsed || !stats ? 'true' : 'false',
            id_elevation_details: `elevation-details${suffix}`,
            hide_elevation: eleModel ? 'false' : 'true',
            id_elevation_chart: `elevation-chart${suffix}`,
            elevation_chart_class: isCompareMode
              ? 'elevation-chart is-compact'
              : 'elevation-chart',
            hide_readout: 'true',
            hover_ele: '',
            hover_grade: '',
            hover_grade_style: 'background-color: #22c55e',
            hover_dist: '',
            hide_hover_surf: 'true',
            hover_surf_dot_style: '',
            hover_surf_label: '',
            hide_hover_road: 'true',
            hover_road_dot_style: '',
            hover_road_label: '',
            hide_hover_traffic: 'true',
            hover_traffic_dot_style: '',
            hover_traffic_label: '',
            hide_hover_noise: 'true',
            hover_noise_label: '',
            hide_hover_speed: 'true',
            hover_speed_label: '',
            chart_spec: eleModel?.specJson || '',
            id_surface_details: `surface-details${suffix}`,
            hide_surface: surfModel.specJson ? 'false' : 'true',
            id_surface_section: `surface-section${suffix}`,
            surface_spec: surfModel.specJson,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      syncChain = syncChain
        .then(async () => {
          if (!store) return;
          isSyncingStore = true;
          try {
            await store.write('ui_state', [{ key: 'main', row: uiRow }]);
            await syncTableRows(store, 'profile_slot', slotRows);
            await syncTableRows(store, 'search_result', searchRows);
            await syncTableRows(store, 'waypoint', wpRows);
            await syncTableRows(store, 'avoid_area', avoidRows);
            await syncTableRows(store, 'route_bar', barRows);
          } finally {
            isSyncingStore = false;
          }
        })
        .catch((err) => console.error('Omnishell store sync error:', err));
    };

    // Initial load from Hash or LocalStorage
    const fromLink = /(?:^#|&)(?:r|nogos|p)=/.test(location.hash);
    const saved = loadSavedRoute();
    const initial = fromLink ? parseHash() : saved;
    if (initial) {
      const initWps = fromLink
        ? mergeSavedWaypointNames(initial.waypoints || [], saved?.waypoints)
        : initial.waypoints || [];
      const initAvoids = initial.avoidAreas || [];
      const initProfs: ProfileName[] =
        initial.profiles && initial.profiles.length > 0
          ? initial.profiles
          : saved?.profiles && saved.profiles.length > 0
            ? saved.profiles
            : ['fastbike-lowtraffic'];

      slots = initProfs.map((p) => ({
        profile: p,
        alternativeIdx: 0,
        route: null,
        isRouting: false,
      }));
      activeSlotRouteId = slots.map(() => null);
      requestedSlotAlt = slots.map(() => 0);
      shownSlotAlt = slots.map(() => 0);
      waypoints = initWps;
      avoidAreas = initAvoids;
      saveToUrlAndStorage(initWps, initProfs, initAvoids);
      geocodeUnnamedWaypoints(initWps);
      if (initWps.length > 0) {
        mapController.triggerFitBounds();
      }
      if (initWps.length >= 2) {
        requestAllSlots(initWps, slots, initAvoids, true);
      } else {
        syncAll();
      }
    } else {
      syncAll();
    }

    const onHashChange = () => {
      const parsed = parseHash();
      const hashWps = parsed
        ? mergeSavedWaypointNames(parsed.waypoints || [], waypoints)
        : [];
      const hashAvoids = parsed?.avoidAreas || [];
      const currentProfs = slots.map((s) => s.profile);
      const hashProfs =
        parsed?.profiles && parsed.profiles.length > 0 ? parsed.profiles : currentProfs;

      const sameWps =
        hashWps.length === waypoints.length &&
        hashWps.every(
          (w, i) =>
            Math.abs(w.lat - waypoints[i].lat) < 1e-5 &&
            Math.abs(w.lon - waypoints[i].lon) < 1e-5,
        );
      const sameAvoids =
        hashAvoids.length === avoidAreas.length &&
        hashAvoids.every(
          (a, i) =>
            Math.abs(a.lat - avoidAreas[i].lat) < 1e-5 &&
            Math.abs(a.lon - avoidAreas[i].lon) < 1e-5 &&
            Math.round(a.radius) === Math.round(avoidAreas[i].radius) &&
            a.weight === avoidAreas[i].weight,
        );
      const sameProfs =
        hashProfs.length === currentProfs.length &&
        hashProfs.every((p, i) => p === currentProfs[i]);

      if (sameWps && sameProfs && sameAvoids) {
        return;
      }

      slots = hashProfs.map((p) => ({
        profile: p,
        alternativeIdx: 0,
        route: null,
        isRouting: false,
      }));
      activeSlotRouteId = slots.map(() => null);
      requestedSlotAlt = slots.map(() => 0);
      shownSlotAlt = slots.map(() => 0);
      waypoints = hashWps;
      avoidAreas = hashAvoids;
      geocodeUnnamedWaypoints(hashWps);
      requestAllSlots(hashWps, slots, hashAvoids, true);
    };

    window.addEventListener('hashchange', onHashChange);

    // Subscribe to Omnishell store changes emitted by pure Jessie reducer (`ui-action.js`)
    // and declarative `<form data-action="update">` controls.
    const handleHostCmd = async (rawCmd: string) => {
      let parsed: Record<string, any>;
      try {
        parsed = JSON.parse(rawCmd);
      } catch {
        return;
      }
      if (!parsed || typeof parsed.cmd !== 'string') return;
      switch (parsed.cmd) {
        case 'refresh-offline-status':
          offlineController.refreshStatus();
          break;
        case 'clear-search':
          searchQuery = '';
          searchResults = [];
          isSearchOpen = false;
          searchStatusText = null;
          syncAll();
          break;
        case 'add-profile':
          addProfileSlot();
          break;
        case 'remove-profile':
          removeProfileSlot(Number(parsed.slotIdx ?? 0));
          break;
        case 'select-alt':
          selectSlotAlternative(Number(parsed.slotIdx ?? 0), Number(parsed.altIdx ?? 0));
          break;
        case 'undo':
          undo();
          break;
        case 'redo':
          redo();
          break;
        case 'reverse-route':
          reverseRoute();
          break;
        case 'clear-route':
          clearRoute();
          break;
        case 'clear-avoids':
          clearAvoidAreas();
          break;
        case 'wp-locate': {
          const wp = waypoints[Number(parsed.idx ?? -1)];
          if (wp) mapController.flyTo(wp.lon, wp.lat);
          break;
        }
        case 'wp-edit':
          startInlineRename(Number(parsed.idx ?? -1));
          break;
        case 'wp-reorder':
          reorderWaypoints(Number(parsed.fromIdx ?? 0), Number(parsed.toIdx ?? 0));
          break;
        case 'wp-delete':
          removeWaypoint(Number(parsed.idx ?? 0));
          break;
        case 'avoid-locate': {
          const area = avoidAreas[Number(parsed.idx ?? -1)];
          if (area) mapController.flyTo(area.lon, area.lat);
          break;
        }
        case 'avoid-radius': {
          const idx = Number(parsed.idx ?? -1);
          const area = avoidAreas[idx];
          if (area) {
            const r = Math.round(area.radius);
            const nextRadius =
              AVOID_RADIUS_PRESETS[
                (AVOID_RADIUS_PRESETS.indexOf(r) + 1) % AVOID_RADIUS_PRESETS.length
              ] || AVOID_RADIUS_PRESETS[0];
            updateAvoidAreaRadius(idx, nextRadius);
          }
          break;
        }
        case 'avoid-delete':
          removeAvoidArea(Number(parsed.idx ?? 0));
          break;
        case 'search-pick': {
          const idx = Number(parsed.idx ?? -1);
          const action = parsed.action as 'start' | 'via' | 'end' | 'append' | undefined;
          const item = searchResults[idx];
          if (item) {
            searchQuery = '';
            searchResults = [];
            isSearchOpen = false;
            searchStatusText = null;
            addWaypoint(
              { lat: item.lat, lon: item.lon, name: item.name },
              action === 'append' ? undefined : action,
            );
            mapController.flyTo(item.lon, item.lat, 14);
          }
          break;
        }
        case 'my-location': {
          if (!('geolocation' in navigator)) {
            setStatusMsg('This browser cannot find your location.', true);
            break;
          }
          setStatusMsg('Finding your location...', false);
          const onPosition = (pos: GeolocationPosition) => {
            const here = { lat: pos.coords.latitude, lon: pos.coords.longitude };
            const shouldFly = waypoints.length < 2;
            addWaypoint(here, 'start');
            if (shouldFly) {
              mapController.flyTo(here.lon, here.lat, 14);
            } else {
              mapController.triggerFitBounds();
            }
          };
          const onFinalError = (err: GeolocationPositionError) => {
            if (err.code === 1) {
              setStatusMsg(
                'Location permission was denied. Allow it in browser settings and try again.',
                true,
              );
            } else if (err.code === 2) {
              setStatusMsg(
                'Location is unavailable. On macOS, check System Settings > Privacy & Security > Location Services for your browser.',
                true,
              );
            } else if (err.code === 3) {
              setStatusMsg('Finding your location took too long. Try again.', true);
            } else {
              setStatusMsg(`Could not find your location: ${err.message}`, true);
            }
          };
          navigator.geolocation.getCurrentPosition(
            onPosition,
            (err) => {
              if (err.code === 1) {
                onFinalError(err);
                return;
              }
              navigator.geolocation.getCurrentPosition(onPosition, onFinalError, {
                enableHighAccuracy: false,
                timeout: 15000,
                maximumAge: 300000,
              });
            },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
          );
          break;
        }
        case 'share': {
          const url = getShareableRouteUrl();
          try {
            if (typeof window !== 'undefined' && window.AndroidNative?.shareText) {
              if (window.AndroidNative.shareText('GBRouter route', url)) {
                break;
              }
            }
            if (
              navigator.share &&
              (isNativePlatform() || window.matchMedia('(pointer: coarse)').matches)
            ) {
              await navigator.share({ title: 'GBRouter route', url });
            } else {
              await navigator.clipboard.writeText(url);
              shareCopied = true;
              setStatusMsg('Link copied. Anyone who opens it sees this route.', false);
              setTimeout(() => {
                shareCopied = false;
                syncAll();
              }, 2000);
            }
          } catch (err: any) {
            if (err instanceof DOMException && err.name === 'AbortError') break;
            setStatusMsg(`Could not share: ${err.message || String(err)}`, true);
          }
          break;
        }
        case 'export-gpx': {
          const primaryRoute = slots[0]?.route;
          if (!primaryRoute) break;
          const startName = waypoints[0]?.name;
          const endName = waypoints[waypoints.length - 1]?.name;
          const primaryProf = slots[0]?.profile || 'fastbike-lowtraffic';
          const trackName =
            startName && endName ? `${startName} to ${endName}` : `${primaryProf}_route`;
          const filename = `${trackName.replace(/[/\\?%*:|"<>]/g, '_')}.gpx`;
          await downloadGpxFile(routeToGpx(primaryRoute, trackName), filename);
          setStatusMsg(`Route exported as ${filename}`, false);
          break;
        }
        case 'download-offline':
          await offlineController.downloadBundle(false);
          break;
        case 'delete-offline':
          await offlineController.deleteBundle();
          break;
        case 'update-offline':
          await offlineController.updateBundle();
          break;
      }
    };

    const unsubStoreUi = store?.subscribe?.('ui_state', async () => {
      const rows = (await store.query('ui_state', null, { filter: 'id=eq.main', current: true })) ?? [];
      const row = rows[0];
      if (!row) return;

      if (row.host_cmd) {
        const cmdStr = String(row.host_cmd);
        isSyncingStore = true;
        await store.patch('ui_state', [{ key: 'main', changes: { host_cmd: '' } }]);
        isSyncingStore = false;
        await handleHostCmd(cmdStr);
        return;
      }

      if (isSyncingStore) return;

      let stateChanged = false;
      const nextCollapsed = row.controls_class === 'collapsed';
      if (nextCollapsed !== isControlsCollapsed) {
        isControlsCollapsed = nextCollapsed;
        stateChanged = true;
      }
      const nextSettings = row.hide_settings_modal === 'false';
      if (nextSettings !== isSettingsOpen) {
        isSettingsOpen = nextSettings;
        stateChanged = true;
      }
      const nextAbout = row.hide_about_modal === 'false';
      if (nextAbout !== isAboutOpen) {
        isAboutOpen = nextAbout;
        stateChanged = true;
      }
      if (row.units && (row.units === 'metric' || row.units === 'imperial') && row.units !== units) {
        setUnits(row.units);
      }
      if (row.theme && (row.theme === 'auto' || row.theme === 'light' || row.theme === 'dark') && row.theme !== theme) {
        setTheme(row.theme);
      }
      const nextOffline = row.offline_mode === true || row.offline_mode === 'true';
      if (nextOffline !== offlineController.isOfflineMode && offlineController.bundleStatus.ready) {
        offlineController.setOfflineMode(nextOffline);
      }
      if (stateChanged) {
        syncAll();
      }
    });

    const unsubStoreSlot = store?.subscribe?.('profile_slot', async () => {
      if (isSyncingStore) return;
      const rows = (await store.query('profile_slot', null, {})) ?? [];
      for (const row of rows) {
        const idx = Number(row.slot_idx ?? String(row.id || '').replace('slot_', ''));
        if (
          !Number.isNaN(idx) &&
          idx >= 0 &&
          idx < slots.length &&
          validProfile(row.profile) &&
          slots[idx].profile !== row.profile
        ) {
          setSlotProfile(idx, row.profile);
          break;
        }
      }
    });

    const unsubStoreBar = store?.subscribe?.('route_bar', async () => {
      if (isSyncingStore) return;
      const rows = (await store.query('route_bar', null, {})) ?? [];
      let changed = false;
      for (const row of rows) {
        const idx = Number(row.slot_idx ?? String(row.id || '').replace('bar_', ''));
        if (Number.isNaN(idx)) continue;
        const barCollapsed = String(row.card_class || '').includes('collapsed');
        if (slots.length > 1) {
          if (Boolean(collapsedSlots[idx]) !== barCollapsed) {
            collapsedSlots[idx] = barCollapsed;
            isRouteInfoCollapsed = slots.every((_, i) => Boolean(collapsedSlots[i]));
            changed = true;
          }
        } else if (idx === 0 && isRouteInfoCollapsed !== barCollapsed) {
          isRouteInfoCollapsed = barCollapsed;
          changed = true;
        }
      }
      if (changed) {
        syncAll();
      }
    });

    // DOM Event Delegation on `screen` (only for browser-gesture file input, tooltip positioning,
    // modal backdrop click, and interactive SVG chart segment highlight)
    const onScreenClick = async (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      const popoverEl = screen.querySelector('#info-popover') as HTMLElement | null;
      const infoBtn = target.closest('.info-btn') as HTMLElement | null;
      if (infoBtn && popoverEl) {
        e.preventDefault();
        e.stopPropagation();
        const tooltip = infoBtn.dataset.tooltip || '';
        if (!popoverEl.hidden && infoBtn.classList.contains('active')) {
          popoverEl.hidden = true;
          infoBtn.classList.remove('active');
          return;
        }
        screen.querySelectorAll('.info-btn.active').forEach((el) => el.classList.remove('active'));
        infoBtn.classList.add('active');
        popoverEl.textContent = tooltip;
        popoverEl.hidden = false;
        const btnRect = infoBtn.getBoundingClientRect();
        const popRect = popoverEl.getBoundingClientRect();
        let left = btnRect.left + btnRect.width / 2 - (popRect.width || 240) / 2;
        left = Math.max(8, Math.min(window.innerWidth - (popRect.width || 240) - 8, left));
        let top = btnRect.top - (popRect.height || 56) - 8;
        if (top < 8) top = btnRect.bottom + 8;
        popoverEl.style.left = `${left}px`;
        popoverEl.style.top = `${top}px`;
        return;
      }
      if (popoverEl && !popoverEl.hidden && !popoverEl.contains(target)) {
        popoverEl.hidden = true;
        screen.querySelectorAll('.info-btn.active').forEach((el) => el.classList.remove('active'));
      }

      if (target.id === 'settings-modal') {
        isSettingsOpen = false;
        syncAll();
        return;
      }
      if (target.id === 'about-modal') {
        isAboutOpen = false;
        syncAll();
        return;
      }

      const btn = target.closest('button') as HTMLButtonElement | null;
      if (btn?.id === 'btn-import-gpx') {
        const fileInput = screen.querySelector('#input-import-gpx') as HTMLInputElement | null;
        fileInput?.click();
        return;
      }

      // Header click when collapsed -> expand controls
      const headerEl = target.closest('.header') as HTMLElement | null;
      if (headerEl && isControlsCollapsed && !target.closest('button')) {
        isControlsCollapsed = false;
        syncAll();
        return;
      }

      // Surface legend item or bar segment click
      const legendEl = target.closest('.surface-legend-item') as HTMLElement | null;
      const segEl = target.closest('.surface-segment') as Element | null;
      if (legendEl || segEl) {
        const sectionEl = target.closest('.surface-section') as HTMLElement | null;
        const rowEl = target.closest('.profile-bar-row') as HTMLElement | null;
        if (sectionEl && rowEl) {
          const slotIdx = Number(sectionEl.dataset.slotIdx ?? 0);
          const rows = breakdownModels.get(slotIdx) || [];
          const allRowEls = Array.from(sectionEl.querySelectorAll('.profile-bar-row'));
          const rowIdx = allRowEls.indexOf(rowEl);
          const rowModel = rows[rowIdx];
          if (rowModel) {
            let pickedLabel: string | null = null;
            if (legendEl) {
              const allLegendEls = Array.from(rowEl.querySelectorAll('.surface-legend-item'));
              const lIdx = allLegendEls.indexOf(legendEl);
              pickedLabel = rowModel.items[lIdx]?.[0] || null;
            } else if (segEl) {
              const allSegEls = Array.from(rowEl.querySelectorAll('.surface-segment'));
              const sIdx = allSegEls.indexOf(segEl);
              pickedLabel = rowModel.segments[sIdx]?.label || null;
            }
            if (pickedLabel) {
              const curr = activeHighlights.get(slotIdx);
              if (curr && curr.rowTitle === rowModel.title && curr.label === pickedLabel) {
                activeHighlights.set(slotIdx, null);
                setSegmentHighlight(null);
              } else {
                activeHighlights.set(slotIdx, { rowTitle: rowModel.title, label: pickedLabel });
                const matching = rowModel.segments.filter((s) => s.label === pickedLabel);
                const coordinates = matching.map((s) => s.coords).filter((c) => c.length >= 2);
                const color = matching[0]?.color || '#f59e0b';
                setSegmentHighlight(coordinates.length > 0 ? { coordinates, color } : null);
              }
              syncAll();
            }
          }
        }
      }
    };

    const onScreenDblClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const wpInfo = target.closest('.wp-info') as HTMLElement | null;
      if (wpInfo) {
        e.stopPropagation();
        const idx = Number(wpInfo.dataset.wpIdx ?? -1);
        startInlineRename(idx);
      }
    };

    const onScreenChange = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      if (target.id === 'input-import-gpx') {
        const input = target as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          const text = String(reader.result || '');
          if (text) {
            importGpxContent(text, 20);
          }
          input.value = '';
        };
        reader.readAsText(file);
      }
    };

    const onScreenInput = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      if (target.id === 'input-place-search') {
        const val = (target as HTMLInputElement).value;
        searchQuery = val;
        if (searchDebounceTimer) window.clearTimeout(searchDebounceTimer);

        const trimmed = val.trim();
        if (trimmed.length < 2) {
          searchResults = [];
          isSearchOpen = false;
          searchStatusText = null;
          syncAll();
          return;
        }

        const coordMatch = parseCoordinateInput(trimmed);
        if (coordMatch) {
          const label = coordMatch.name || `${coordMatch.lat.toFixed(5)}, ${coordMatch.lon.toFixed(5)}`;
          searchResults = [
            {
              lat: coordMatch.lat,
              lon: coordMatch.lon,
              title: label,
              subtitle: 'Coordinates',
              name: label,
            },
          ];
          activeSearchIdx = 0;
          searchStatusText = null;
          isSearchOpen = true;
          syncAll();
          return;
        }

        if (offlineController.isOfflineMode) {
          searchResults = [];
          searchStatusText =
            'Place search is unavailable in Offline Mode. Enter coordinates (lat, lon).';
          isSearchOpen = true;
          syncAll();
          return;
        }

        searchDebounceTimer = window.setTimeout(async () => {
          searchStatusText = 'Searching…';
          isSearchOpen = true;
          syncAll();
          const c = mapController.map.getCenter();
          const res = await searchPlaces(trimmed, { lat: c.lat, lon: c.lng });
          searchResults = res;
          activeSearchIdx = res.length > 0 ? 0 : -1;
          searchStatusText = res.length === 0 ? 'No places found' : null;
          syncAll();
        }, 240);
        return;
      }

      if (target.id === 'input-thunderforest-key') {
        const nextKey = (target as HTMLInputElement).value.trim();
        setThunderforestKey(nextKey);
        thunderforestKey = getThunderforestKey();
        syncAll();
        return;
      }

      if (target.classList.contains('wp-rename-input')) {
        editWpValue = (target as HTMLInputElement).value;
      }
    };

    const onScreenKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      if (target.id === 'input-place-search') {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (searchResults.length > 0) {
            activeSearchIdx = Math.min(activeSearchIdx + 1, searchResults.length - 1);
            syncAll();
          }
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (searchResults.length > 0) {
            activeSearchIdx = Math.max(activeSearchIdx - 1, 0);
            syncAll();
          }
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const pick =
            searchResults[activeSearchIdx >= 0 ? activeSearchIdx : 0] ||
            parseCoordinateInput(searchQuery);
          if (pick) {
            searchQuery = '';
            searchResults = [];
            isSearchOpen = false;
            searchStatusText = null;
            addWaypoint({ lat: pick.lat, lon: pick.lon, name: pick.name });
            mapController.flyTo(pick.lon, pick.lat, 14);
          }
        } else if (e.key === 'Escape') {
          isSearchOpen = false;
          syncAll();
        }
        return;
      }

      if (target.classList.contains('wp-rename-input')) {
        const idx = Number(target.dataset.wpIdx ?? -1);
        if (e.key === 'Enter') {
          e.preventDefault();
          renameWaypoint(idx, editWpValue);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          editingWpIdx = null;
          syncAll();
        }
      }
    };

    const onScreenFocusOut = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.classList.contains('wp-rename-input') && editingWpIdx !== null) {
        const idx = Number(target.dataset.wpIdx ?? -1);
        renameWaypoint(idx, editWpValue);
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      const chartWrap = target.closest('.elevation-chart') as HTMLElement | null;
      if (!chartWrap) return;
      const svg = chartWrap.querySelector('svg') as SVGSVGElement | null;
      if (!svg) return;

      const slotIdx = Number(chartWrap.dataset.slotIdx ?? 0);
      const model = elevationModels.get(slotIdx);
      if (!model) return;

      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0) return;
      const svgX = ((e.clientX - rect.left) / rect.width) * model.W;
      const frac = (svgX - model.padL) / model.plotW;
      const readout = computeHoverReadout(model, frac, units);

      setHoverPosition({ lon: readout.pt.lon, lat: readout.pt.lat });

      const feat = slots[slotIdx]?.route?.features?.[0];
      const coords = (feat?.geometry as GeoJSON.LineString | undefined)?.coordinates;
      const hoverSpecJson = coords
        ? JSON.stringify({
            coords,
            slotIdx,
            compact: slots.length > 1,
            units,
            hoverDist: readout.pt.dist,
          })
        : model.specJson;

      if (store) {
        isSyncingStore = true;
        store
          .patch('route_bar', [
            {
              key: `bar_${slotIdx}`,
              changes: { ...readout.fields, chart_spec: hoverSpecJson },
            },
          ])
          .finally(() => {
            isSyncingStore = false;
          });
      }
    };

    const onPointerOut = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      const chartWrap = target.closest('.elevation-chart') as HTMLElement | null;
      if (!chartWrap) return;
      const related = e.relatedTarget as Node | null;
      if (related && chartWrap.contains(related)) return;

      const slotIdx = Number(chartWrap.dataset.slotIdx ?? 0);
      const model = elevationModels.get(slotIdx);
      setHoverPosition(null);
      if (store) {
        isSyncingStore = true;
        store
          .patch('route_bar', [
            {
              key: `bar_${slotIdx}`,
              changes: {
                hide_readout: 'true',
                ...(model ? { chart_spec: model.specJson } : {}),
              },
            },
          ])
          .finally(() => {
            isSyncingStore = false;
          });
      }
    };

    const onWindowKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        if (e.key === 'Escape') {
          isSettingsOpen = false;
          isAboutOpen = false;
          syncAll();
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z')
      ) {
        e.preventDefault();
        redo();
      } else if (e.key === 'Escape') {
        isSettingsOpen = false;
        isAboutOpen = false;
        syncAll();
      }
    };

    screen.addEventListener('click', onScreenClick);
    screen.addEventListener('dblclick', onScreenDblClick);
    screen.addEventListener('change', onScreenChange);
    screen.addEventListener('input', onScreenInput);
    screen.addEventListener('keydown', onScreenKeyDown);
    screen.addEventListener('focusout', onScreenFocusOut);
    screen.addEventListener('pointermove', onPointerMove);
    screen.addEventListener('pointerout', onPointerOut);
    window.addEventListener('keydown', onWindowKeyDown);

    const cleanup = () => {
      unsubBasemap();
      unsubStoreUi?.();
      unsubStoreSlot?.();
      unsubStoreBar?.();
      window.removeEventListener('hashchange', onHashChange);
      screen.removeEventListener('click', onScreenClick);
      screen.removeEventListener('dblclick', onScreenDblClick);
      screen.removeEventListener('change', onScreenChange);
      screen.removeEventListener('input', onScreenInput);
      screen.removeEventListener('keydown', onScreenKeyDown);
      screen.removeEventListener('focusout', onScreenFocusOut);
      screen.removeEventListener('pointermove', onPointerMove);
      screen.removeEventListener('pointerout', onPointerOut);
      window.removeEventListener('keydown', onWindowKeyDown);
      offlineController.destroy();
      worker.terminate();
      mapController.destroy();
    };

    env.signal?.addEventListener('abort', cleanup, { once: true });
    return cleanup;
  };
}
