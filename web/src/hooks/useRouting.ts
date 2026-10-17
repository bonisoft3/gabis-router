import { useState, useEffect, useRef, useCallback } from 'react';
import {
  MAX_ROUTE_SLOTS,
  PROFILE_INFO,
  PROFILE_ORDER,
  type AvoidArea,
  type LatLon,
  type ProfileName,
  type RouteSlotState,
  type WorkerMessage,
} from '../types.ts';
import { HistoryStack } from '../history.ts';
import { legIndexAt } from '../utils/geo.ts';

const STORAGE_KEY = 'rsrouter_route';
const MAX_UNDO = 50;
export const DEFAULT_AVOID_RADIUS_M = 50;

interface RouteHistorySnapshot {
  waypoints: LatLon[];
  avoidAreas: AvoidArea[];
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

export function useRouting(isOfflineMode: boolean) {
  const [slots, setSlotsState] = useState<RouteSlotState[]>([
    { profile: 'fastbike-lowtraffic', alternativeIdx: 0, route: null, isRouting: false },
  ]);
  const [waypoints, setWaypointsState] = useState<LatLon[]>([]);
  const [avoidAreas, setAvoidAreasState] = useState<AvoidArea[]>([]);
  const [status, setStatus] = useState<string>('Click on the map or search to set start and end points.');
  const [isError, setIsError] = useState<boolean>(false);
  const [canUndo, setCanUndo] = useState<boolean>(false);
  const [canRedo, setCanRedo] = useState<boolean>(false);
  const [fitBoundsSeq, setFitBoundsSeq] = useState<number>(0);

  const historyRef = useRef(new HistoryStack<RouteHistorySnapshot>(MAX_UNDO));
  const workerRef = useRef<Worker | null>(null);
  const activeSlotRouteIdRef = useRef<Array<string | null>>([null]);
  const activeImportIdRef = useRef<string | null>(null);
  const initCompletedRef = useRef<boolean>(false);
  const routeCounterRef = useRef<number>(0);
  const requestedSlotAltRef = useRef<number[]>([0]);
  const shownSlotAltRef = useRef<number[]>([0]);

  const slotsRef = useRef<RouteSlotState[]>(slots);
  slotsRef.current = slots;
  const waypointsRef = useRef(waypoints);
  waypointsRef.current = waypoints;
  const avoidAreasRef = useRef(avoidAreas);
  avoidAreasRef.current = avoidAreas;

  const updateUndoRedo = useCallback(() => {
    setCanUndo(historyRef.current.canUndo());
    setCanRedo(historyRef.current.canRedo());
  }, []);

  const setStatusMsg = useCallback((msg: string, error = false) => {
    setStatus(msg);
    setIsError(error);
  }, []);

  const saveToUrlAndStorage = useCallback((wps: LatLon[], profs: ProfileName[], avoids: AvoidArea[]) => {
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
      history.replaceState(null, '', location.pathname + location.search);
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
        .map((a) => `${a.lon.toFixed(5)},${a.lat.toFixed(5)},${Math.round(a.radius)}${a.weight !== undefined ? ',' + a.weight : ''}`)
        .join(';');
      parts.push(`nogos=${encodeURIComponent(nogos)}`);
    }
    history.replaceState(null, '', location.pathname + location.search + '#' + parts.join('&'));
  }, []);

  const postSlotRouteRequest = useCallback(
    (slotIdx: number, wps: LatLon[], prof: ProfileName, avoids: AvoidArea[], altIdx = 0) => {
      if (!workerRef.current || wps.length < 2) return;
      const id = String(++routeCounterRef.current);
      activeSlotRouteIdRef.current[slotIdx] = id;
      requestedSlotAltRef.current[slotIdx] = altIdx;

      workerRef.current.postMessage({
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
    },
    [],
  );

  const requestAllSlots = useCallback(
    (wps: LatLon[], currentSlots: RouteSlotState[], avoids: AvoidArea[], resetAlt = true) => {
      if (wps.length < 2) {
        activeSlotRouteIdRef.current = currentSlots.map(() => null);
        requestedSlotAltRef.current = currentSlots.map(() => 0);
        shownSlotAltRef.current = currentSlots.map(() => 0);
        const cleared = currentSlots.map((s) => ({
          ...s,
          alternativeIdx: 0,
          route: null,
          isRouting: false,
        }));
        slotsRef.current = cleared;
        setSlotsState(cleared);
        setIsError(false);
        setStatus(
          wps.length === 1
            ? 'Start point set. Click on the map or search to set destination.'
            : 'Click on the map or search to set start and end points.',
        );
        return;
      }
      if (!workerRef.current) return;

      setStatus('Calculating route...');
      setIsError(false);

      const updated = currentSlots.map((s, idx) => {
        const alt = resetAlt ? 0 : s.alternativeIdx;
        if (resetAlt) {
          requestedSlotAltRef.current[idx] = 0;
          shownSlotAltRef.current[idx] = 0;
        }
        return {
          ...s,
          alternativeIdx: alt,
          isRouting: true,
        };
      });
      slotsRef.current = updated;
      setSlotsState(updated);

      updated.forEach((slot, idx) => {
        postSlotRouteRequest(idx, wps, slot.profile, avoids, slot.alternativeIdx);
      });
    },
    [postSlotRouteRequest],
  );

  // Worker initialization and offline sync
  useEffect(() => {
    const worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    initCompletedRef.current = false;

    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const msg = e.data;
      switch (msg.type) {
        case 'STATUS': {
          const anyActive =
            activeImportIdRef.current !== null ||
            activeSlotRouteIdRef.current.some((id) => id !== null);
          if (!initCompletedRef.current) {
            if (msg.message.startsWith('Router ready') || msg.message.startsWith('Initialization failed')) {
              initCompletedRef.current = true;
            }
            if (!anyActive && waypointsRef.current.length === 0) {
              setStatus(msg.message);
              setIsError(msg.message.startsWith('Initialization failed'));
            }
          } else if (anyActive) {
            setStatus(msg.message);
            setIsError(false);
          }
          break;
        }
        case 'ROUTE_SUCCESS': {
          const slotIdx = activeSlotRouteIdRef.current.indexOf(msg.id);
          if (slotIdx === -1) break;
          activeSlotRouteIdRef.current[slotIdx] = null;
          const altIdx = requestedSlotAltRef.current[slotIdx] ?? 0;
          shownSlotAltRef.current[slotIdx] = altIdx;

          const nextSlots = slotsRef.current.map((s, idx) =>
            idx === slotIdx
              ? { ...s, route: msg.payload, alternativeIdx: altIdx, isRouting: false }
              : s,
          );
          slotsRef.current = nextSlots;
          setSlotsState(nextSlots);

          const stillRouting = nextSlots.some((s) => s.isRouting);
          if (!stillRouting) {
            setIsError(false);
            setStatus('');
          }
          break;
        }
        case 'IMPORT_GPX_SUCCESS': {
          if (msg.id !== activeImportIdRef.current) break;
          activeImportIdRef.current = null;
          if (waypointsRef.current.length > 0 || avoidAreasRef.current.length > 0) {
            historyRef.current.record({
              waypoints: waypointsRef.current.map((w) => ({ ...w })),
              avoidAreas: avoidAreasRef.current.map((a) => ({ ...a })),
            });
            updateUndoRedo();
          }
          const newWps = msg.payload.waypoints;
          waypointsRef.current = newWps;
          avoidAreasRef.current = [];
          setWaypointsState(newWps);
          setAvoidAreasState([]);

          const nextSlots = slotsRef.current.map((s, idx) => {
            shownSlotAltRef.current[idx] = 0;
            requestedSlotAltRef.current[idx] = 0;
            if (idx === 0) {
              activeSlotRouteIdRef.current[0] = null;
              return { ...s, alternativeIdx: 0, route: msg.payload.route, isRouting: false };
            }
            return { ...s, alternativeIdx: 0, isRouting: newWps.length >= 2 };
          });
          slotsRef.current = nextSlots;
          setSlotsState(nextSlots);

          saveToUrlAndStorage(
            newWps,
            nextSlots.map((s) => s.profile),
            [],
          );
          setFitBoundsSeq((s) => s + 1);

          if (newWps.length >= 2 && nextSlots.length > 1) {
            for (let idx = 1; idx < nextSlots.length; idx++) {
              postSlotRouteRequest(idx, newWps, nextSlots[idx].profile, [], 0);
            }
          } else {
            setIsError(false);
            setStatus('');
          }
          break;
        }
        case 'ROUTE_ERROR': {
          if (msg.id === activeImportIdRef.current) {
            activeImportIdRef.current = null;
            const nextSlots = slotsRef.current.map((s) => ({ ...s, isRouting: false }));
            slotsRef.current = nextSlots;
            setSlotsState(nextSlots);
            setStatus(`Routing error: ${msg.error}`);
            setIsError(true);
            break;
          }
          const slotIdx = activeSlotRouteIdRef.current.indexOf(msg.id);
          if (slotIdx === -1) break;
          activeSlotRouteIdRef.current[slotIdx] = null;

          const reqAlt = requestedSlotAltRef.current[slotIdx] ?? 0;
          const prevAlt = shownSlotAltRef.current[slotIdx] ?? 0;
          const currentSlot = slotsRef.current[slotIdx];

          if (reqAlt > 0 && currentSlot?.route) {
            const failedAlt = reqAlt + 1;
            requestedSlotAltRef.current[slotIdx] = prevAlt;
            const nextSlots = slotsRef.current.map((s, idx) =>
              idx === slotIdx ? { ...s, alternativeIdx: prevAlt, isRouting: false } : s,
            );
            slotsRef.current = nextSlots;
            setSlotsState(nextSlots);
            setStatus(
              `Alternative ${failedAlt} is not available for ${PROFILE_INFO[currentSlot.profile]?.shortLabel || currentSlot.profile}.`,
            );
            setIsError(true);
            break;
          }

          const nextSlots = slotsRef.current.map((s, idx) =>
            idx === slotIdx ? { ...s, route: null, isRouting: false } : s,
          );
          slotsRef.current = nextSlots;
          setSlotsState(nextSlots);
          setStatus(`Routing error: ${msg.error}`);
          setIsError(true);
          break;
        }
      }
    };

    worker.postMessage({ type: 'SET_OFFLINE_MODE', offline: isOfflineMode } satisfies WorkerMessage);
    worker.postMessage({ type: 'INIT' } satisfies WorkerMessage);

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

      const initSlots: RouteSlotState[] = initProfs.map((p) => ({
        profile: p,
        alternativeIdx: 0,
        route: null,
        isRouting: false,
      }));
      activeSlotRouteIdRef.current = initSlots.map(() => null);
      requestedSlotAltRef.current = initSlots.map(() => 0);
      shownSlotAltRef.current = initSlots.map(() => 0);

      waypointsRef.current = initWps;
      avoidAreasRef.current = initAvoids;
      slotsRef.current = initSlots;
      setWaypointsState(initWps);
      setAvoidAreasState(initAvoids);
      setSlotsState(initSlots);
      saveToUrlAndStorage(initWps, initProfs, initAvoids);
      if (initWps.length > 0) {
        setFitBoundsSeq((s) => s + 1);
      }
      if (initWps.length >= 2) {
        requestAllSlots(initWps, initSlots, initAvoids, true);
      }
    }

    const onHashChange = () => {
      const parsed = parseHash();
      const hashWps = parsed
        ? mergeSavedWaypointNames(parsed.waypoints || [], waypointsRef.current)
        : [];
      const hashAvoids = parsed?.avoidAreas || [];
      const currentProfs = slotsRef.current.map((s) => s.profile);
      const hashProfs = parsed?.profiles && parsed.profiles.length > 0 ? parsed.profiles : currentProfs;

      const sameWps =
        hashWps.length === waypointsRef.current.length &&
        hashWps.every(
          (w, i) =>
            Math.abs(w.lat - waypointsRef.current[i].lat) < 1e-5 &&
            Math.abs(w.lon - waypointsRef.current[i].lon) < 1e-5,
        );
      const sameAvoids =
        hashAvoids.length === avoidAreasRef.current.length &&
        hashAvoids.every(
          (a, i) =>
            Math.abs(a.lat - avoidAreasRef.current[i].lat) < 1e-5 &&
            Math.abs(a.lon - avoidAreasRef.current[i].lon) < 1e-5 &&
            Math.round(a.radius) === Math.round(avoidAreasRef.current[i].radius) &&
            a.weight === avoidAreasRef.current[i].weight,
        );
      const sameProfs =
        hashProfs.length === currentProfs.length &&
        hashProfs.every((p, i) => p === currentProfs[i]);

      if (sameWps && sameProfs && sameAvoids) {
        return;
      }

      const nextSlots: RouteSlotState[] = hashProfs.map((p) => ({
        profile: p,
        alternativeIdx: 0,
        route: null,
        isRouting: false,
      }));
      activeSlotRouteIdRef.current = nextSlots.map(() => null);
      requestedSlotAltRef.current = nextSlots.map(() => 0);
      shownSlotAltRef.current = nextSlots.map(() => 0);

      waypointsRef.current = hashWps;
      avoidAreasRef.current = hashAvoids;
      slotsRef.current = nextSlots;
      setWaypointsState(hashWps);
      setAvoidAreasState(hashAvoids);
      setSlotsState(nextSlots);

      if (hashWps.length >= 2) {
        requestAllSlots(hashWps, nextSlots, hashAvoids, true);
      } else {
        requestAllSlots(hashWps, nextSlots, hashAvoids, true);
      }
    };

    window.addEventListener('hashchange', onHashChange);

    return () => {
      window.removeEventListener('hashchange', onHashChange);
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  // Sync offline mode with worker
  useEffect(() => {
    if (workerRef.current) {
      workerRef.current.postMessage({ type: 'SET_OFFLINE_MODE', offline: isOfflineMode } satisfies WorkerMessage);
    }
  }, [isOfflineMode]);

  const setWaypoints = useCallback(
    (next: LatLon[], recordUndo = true, fitMap = false) => {
      if (recordUndo) {
        historyRef.current.record({
          waypoints: waypointsRef.current.map((w) => ({ ...w })),
          avoidAreas: avoidAreasRef.current.map((a) => ({ ...a })),
        });
        updateUndoRedo();
      }
      waypointsRef.current = next;
      setWaypointsState(next);
      saveToUrlAndStorage(
        next,
        slotsRef.current.map((s) => s.profile),
        avoidAreasRef.current,
      );
      if (fitMap && next.length > 0) {
        setFitBoundsSeq((s) => s + 1);
      }
      requestAllSlots(next, slotsRef.current, avoidAreasRef.current, true);
    },
    [requestAllSlots, saveToUrlAndStorage, updateUndoRedo],
  );

  const setAvoidAreas = useCallback(
    (next: AvoidArea[], recordUndo = true) => {
      if (recordUndo) {
        historyRef.current.record({
          waypoints: waypointsRef.current.map((w) => ({ ...w })),
          avoidAreas: avoidAreasRef.current.map((a) => ({ ...a })),
        });
        updateUndoRedo();
      }
      avoidAreasRef.current = next;
      setAvoidAreasState(next);
      saveToUrlAndStorage(
        waypointsRef.current,
        slotsRef.current.map((s) => s.profile),
        next,
      );
      if (waypointsRef.current.length >= 2) {
        requestAllSlots(waypointsRef.current, slotsRef.current, next, true);
      }
    },
    [requestAllSlots, saveToUrlAndStorage, updateUndoRedo],
  );

  const setSlotProfile = useCallback(
    (slotIdx: number, nextProfile: ProfileName) => {
      if (slotIdx < 0 || slotIdx >= slotsRef.current.length) return;
      requestedSlotAltRef.current[slotIdx] = 0;
      shownSlotAltRef.current[slotIdx] = 0;
      const hasWps = waypointsRef.current.length >= 2;
      const nextSlots = slotsRef.current.map((s, idx) =>
        idx === slotIdx
          ? { ...s, profile: nextProfile, alternativeIdx: 0, isRouting: hasWps }
          : s,
      );
      slotsRef.current = nextSlots;
      setSlotsState(nextSlots);
      saveToUrlAndStorage(
        waypointsRef.current,
        nextSlots.map((s) => s.profile),
        avoidAreasRef.current,
      );
      if (hasWps) {
        setStatus('Calculating route...');
        setIsError(false);
        postSlotRouteRequest(slotIdx, waypointsRef.current, nextProfile, avoidAreasRef.current, 0);
      }
    },
    [postSlotRouteRequest, saveToUrlAndStorage],
  );

  const setProfile = useCallback(
    (next: ProfileName) => {
      setSlotProfile(0, next);
    },
    [setSlotProfile],
  );

  const addProfileSlot = useCallback(
    (initialProfile?: ProfileName) => {
      if (slotsRef.current.length >= MAX_ROUTE_SLOTS) return;
      const usedProfiles = new Set(slotsRef.current.map((s) => s.profile));
      const nextProfile =
        initialProfile && validProfile(initialProfile)
          ? initialProfile
          : PROFILE_ORDER.find((p) => !usedProfiles.has(p)) || PROFILE_ORDER[0];

      const newSlotIdx = slotsRef.current.length;
      const hasWps = waypointsRef.current.length >= 2;
      const nextSlots: RouteSlotState[] = [
        ...slotsRef.current,
        {
          profile: nextProfile,
          alternativeIdx: 0,
          route: null,
          isRouting: hasWps,
        },
      ];
      activeSlotRouteIdRef.current.push(null);
      requestedSlotAltRef.current.push(0);
      shownSlotAltRef.current.push(0);

      slotsRef.current = nextSlots;
      setSlotsState(nextSlots);
      saveToUrlAndStorage(
        waypointsRef.current,
        nextSlots.map((s) => s.profile),
        avoidAreasRef.current,
      );
      if (hasWps) {
        setStatus('Calculating route...');
        setIsError(false);
        postSlotRouteRequest(newSlotIdx, waypointsRef.current, nextProfile, avoidAreasRef.current, 0);
      }
    },
    [postSlotRouteRequest, saveToUrlAndStorage],
  );

  const removeProfileSlot = useCallback(
    (slotIdx: number) => {
      if (slotsRef.current.length <= 1 || slotIdx < 0 || slotIdx >= slotsRef.current.length) return;
      const nextSlots = slotsRef.current.filter((_, idx) => idx !== slotIdx);
      activeSlotRouteIdRef.current.splice(slotIdx, 1);
      requestedSlotAltRef.current.splice(slotIdx, 1);
      shownSlotAltRef.current.splice(slotIdx, 1);

      slotsRef.current = nextSlots;
      setSlotsState(nextSlots);
      saveToUrlAndStorage(
        waypointsRef.current,
        nextSlots.map((s) => s.profile),
        avoidAreasRef.current,
      );
      if (!nextSlots.some((s) => s.isRouting)) {
        setStatus('');
      }
    },
    [saveToUrlAndStorage],
  );

  const selectSlotAlternative = useCallback(
    (slotIdx: number, altIdx: number) => {
      if (
        slotIdx < 0 ||
        slotIdx >= slotsRef.current.length ||
        altIdx === shownSlotAltRef.current[slotIdx] ||
        waypointsRef.current.length < 2
      ) {
        return;
      }
      const nextSlots = slotsRef.current.map((s, idx) =>
        idx === slotIdx ? { ...s, alternativeIdx: altIdx, isRouting: true } : s,
      );
      slotsRef.current = nextSlots;
      setSlotsState(nextSlots);
      setStatus('Calculating route...');
      setIsError(false);
      postSlotRouteRequest(
        slotIdx,
        waypointsRef.current,
        nextSlots[slotIdx].profile,
        avoidAreasRef.current,
        altIdx,
      );
    },
    [postSlotRouteRequest],
  );

  const selectAlternative = useCallback(
    (idx: number) => {
      selectSlotAlternative(0, idx);
    },
    [selectSlotAlternative],
  );

  const addWaypoint = useCallback(
    (p: LatLon, action?: 'start' | 'end' | 'via' | 'append') => {
      const wps = waypointsRef.current;
      let next: LatLon[];
      if (action === 'start') {
        next = wps.length === 0 ? [p] : [p, ...wps.slice(1)];
      } else if (action === 'end') {
        next = wps.length < 2 ? [...wps, p] : [...wps.slice(0, -1), p];
      } else if (action === 'via') {
        if (wps.length < 2) {
          next = [...wps, p];
        } else {
          const primaryRoute = slotsRef.current[0]?.route;
          const coords = (
            primaryRoute?.features[0]?.geometry as GeoJSON.LineString | undefined
          )?.coordinates;
          const leg = legIndexAt(coords, wps, p.lon, p.lat);
          next = [...wps];
          next.splice(Math.max(1, leg + 1), 0, p);
        }
      } else {
        next = [...wps, p];
      }
      setWaypoints(next, true);
    },
    [setWaypoints],
  );

  const insertWaypointAtLeg = useCallback(
    (p: LatLon, insertIndex: number) => {
      const wps = waypointsRef.current;
      const next = [...wps];
      const clampedIndex = Math.max(0, Math.min(next.length, insertIndex));
      next.splice(clampedIndex, 0, p);
      setWaypoints(next, true);
    },
    [setWaypoints],
  );

  const moveWaypoint = useCallback(
    (index: number, p: LatLon) => {
      // Moving a point clears its old cached place name so reverse geocoding can resolve the new location
      const next = waypointsRef.current.map((w, i) =>
        i === index ? { lat: p.lat, lon: p.lon } : w,
      );
      setWaypoints(next, true);
    },
    [setWaypoints],
  );

  const removeWaypoint = useCallback(
    (index: number) => {
      const next = waypointsRef.current.filter((_, i) => i !== index);
      setWaypoints(next, true);
    },
    [setWaypoints],
  );

  const renameWaypoint = useCallback(
    (index: number, name: string, expectedCoords?: { lat: number; lon: number }) => {
      // Renaming only updates display metadata; never re-trigger routing!
      setWaypointsState((prev) => {
        const current = prev[index];
        if (!current) return prev;
        if (expectedCoords) {
          if (
            current.name ||
            Math.abs(current.lat - expectedCoords.lat) > 1e-5 ||
            Math.abs(current.lon - expectedCoords.lon) > 1e-5
          ) {
            return prev;
          }
        }
        const trimmed = name.trim() || undefined;
        if (current.name === trimmed) return prev;
        const next = prev.map((w, i) => (i === index ? { ...w, name: trimmed } : w));
        waypointsRef.current = next;
        const profs = slotsRef.current.map((s) => s.profile);
        try {
          localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
              waypoints: next,
              profile: profs[0],
              profiles: profs,
              avoidAreas: avoidAreasRef.current,
            }),
          );
        } catch {}
        return next;
      });
    },
    [],
  );

  const reorderWaypoints = useCallback(
    (fromIndex: number, toIndex: number) => {
      const next = [...waypointsRef.current];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      setWaypoints(next, true);
    },
    [setWaypoints],
  );

  const reverseRoute = useCallback(() => {
    if (waypointsRef.current.length < 2) return;
    const next = [...waypointsRef.current].reverse();
    setWaypoints(next, true);
  }, [setWaypoints]);

  const addAvoidArea = useCallback(
    (p: LatLon, radius = DEFAULT_AVOID_RADIUS_M) => {
      const next = [...avoidAreasRef.current, { lat: p.lat, lon: p.lon, radius }];
      setAvoidAreas(next, true);
    },
    [setAvoidAreas],
  );

  const updateAvoidAreaRadius = useCallback(
    (index: number, radius: number) => {
      if (!avoidAreasRef.current[index]) return;
      const next = avoidAreasRef.current.map((a, i) =>
        i === index ? { ...a, radius: Math.max(10, radius) } : a,
      );
      setAvoidAreas(next, true);
    },
    [setAvoidAreas],
  );

  const removeAvoidArea = useCallback(
    (index: number) => {
      const next = avoidAreasRef.current.filter((_, i) => i !== index);
      setAvoidAreas(next, true);
    },
    [setAvoidAreas],
  );

  const clearAvoidAreas = useCallback(() => {
    if (avoidAreasRef.current.length === 0) return;
    setAvoidAreas([], true);
  }, [setAvoidAreas]);

  const clearRoute = useCallback(() => {
    if (waypointsRef.current.length === 0 && avoidAreasRef.current.length === 0) return;
    historyRef.current.record({
      waypoints: waypointsRef.current.map((w) => ({ ...w })),
      avoidAreas: avoidAreasRef.current.map((a) => ({ ...a })),
    });
    updateUndoRedo();
    activeImportIdRef.current = null;
    activeSlotRouteIdRef.current = slotsRef.current.map(() => null);
    requestedSlotAltRef.current = slotsRef.current.map(() => 0);
    shownSlotAltRef.current = slotsRef.current.map(() => 0);

    const clearedSlots = slotsRef.current.map((s) => ({
      ...s,
      alternativeIdx: 0,
      route: null,
      isRouting: false,
    }));
    slotsRef.current = clearedSlots;
    waypointsRef.current = [];
    avoidAreasRef.current = [];
    setWaypointsState([]);
    setAvoidAreasState([]);
    setSlotsState(clearedSlots);
    setIsError(false);
    saveToUrlAndStorage(
      [],
      clearedSlots.map((s) => s.profile),
      [],
    );
    setStatus('Route cleared.');
  }, [saveToUrlAndStorage, updateUndoRedo]);

  const undo = useCallback(() => {
    const currentSnap: RouteHistorySnapshot = {
      waypoints: waypointsRef.current.map((w) => ({ ...w })),
      avoidAreas: avoidAreasRef.current.map((a) => ({ ...a })),
    };
    const prev = historyRef.current.undo(currentSnap);
    if (!prev) return;
    waypointsRef.current = prev.waypoints;
    avoidAreasRef.current = prev.avoidAreas;
    setWaypointsState(prev.waypoints);
    setAvoidAreasState(prev.avoidAreas);
    saveToUrlAndStorage(
      prev.waypoints,
      slotsRef.current.map((s) => s.profile),
      prev.avoidAreas,
    );
    requestAllSlots(prev.waypoints, slotsRef.current, prev.avoidAreas, true);
    updateUndoRedo();
  }, [requestAllSlots, saveToUrlAndStorage, updateUndoRedo]);

  const redo = useCallback(() => {
    const currentSnap: RouteHistorySnapshot = {
      waypoints: waypointsRef.current.map((w) => ({ ...w })),
      avoidAreas: avoidAreasRef.current.map((a) => ({ ...a })),
    };
    const next = historyRef.current.redo(currentSnap);
    if (!next) return;
    waypointsRef.current = next.waypoints;
    avoidAreasRef.current = next.avoidAreas;
    setWaypointsState(next.waypoints);
    setAvoidAreasState(next.avoidAreas);
    saveToUrlAndStorage(
      next.waypoints,
      slotsRef.current.map((s) => s.profile),
      next.avoidAreas,
    );
    requestAllSlots(next.waypoints, slotsRef.current, next.avoidAreas, true);
    updateUndoRedo();
  }, [requestAllSlots, saveToUrlAndStorage, updateUndoRedo]);

  const clearWorkerGraph = useCallback(
    (recompute = false) => {
      if (workerRef.current) {
        workerRef.current.postMessage({ type: 'CLEAR_GRAPH' } satisfies WorkerMessage);
      }
      if (recompute && waypointsRef.current.length >= 2) {
        requestAllSlots(waypointsRef.current, slotsRef.current, avoidAreasRef.current, false);
      }
    },
    [requestAllSlots],
  );

  const triggerFitBounds = useCallback(() => {
    setFitBoundsSeq((s) => s + 1);
  }, []);

  const importGpxContent = useCallback((gpxXml: string, toleranceM = 20) => {
    if (!workerRef.current) return;
    setStatus('Matching GPX to road network...');
    setIsError(false);

    const nextSlots = slotsRef.current.map((s, idx) => ({
      ...s,
      isRouting: idx === 0 ? true : s.isRouting,
    }));
    slotsRef.current = nextSlots;
    setSlotsState(nextSlots);

    const id = String(++routeCounterRef.current);
    activeImportIdRef.current = id;
    activeSlotRouteIdRef.current = nextSlots.map(() => null);

    workerRef.current.postMessage({
      type: 'IMPORT_GPX_REQUEST',
      id,
      payload: {
        gpxXml,
        profile: nextSlots[0]?.profile || 'fastbike-lowtraffic',
        toleranceM,
      },
    } satisfies WorkerMessage);
  }, []);

  const importGpxFile = useCallback(
    (file: File, toleranceM = 20) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target?.result as string;
        if (text) importGpxContent(text, toleranceM);
      };
      reader.readAsText(file);
    },
    [importGpxContent],
  );

  const primarySlot = slots[0] || {
    profile: 'fastbike-lowtraffic' as ProfileName,
    alternativeIdx: 0,
    route: null,
    isRouting: false,
  };
  const isRouting = slots.some((s) => s.isRouting);

  return {
    slots,
    addProfileSlot,
    removeProfileSlot,
    setSlotProfile,
    selectSlotAlternative,
    profile: primarySlot.profile,
    setProfile,
    waypoints,
    setWaypoints,
    avoidAreas,
    setAvoidAreas,
    currentRoute: primarySlot.route,
    alternativeIdx: primarySlot.alternativeIdx,
    selectAlternative,
    status,
    isError,
    setStatus: setStatusMsg,
    isRouting,
    canUndo,
    canRedo,
    fitBoundsSeq,
    triggerFitBounds,
    importGpxContent,
    importGpxFile,
    addWaypoint,
    insertWaypointAtLeg,
    moveWaypoint,
    removeWaypoint,
    renameWaypoint,
    reorderWaypoints,
    reverseRoute,
    addAvoidArea,
    updateAvoidAreaRadius,
    removeAvoidArea,
    clearAvoidAreas,
    clearRoute,
    undo,
    redo,
    clearWorkerGraph,
  };
}
