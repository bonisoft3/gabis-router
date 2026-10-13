import { useState, useEffect, useRef, useCallback } from 'react';
import type { AvoidArea, LatLon, ProfileName, WorkerMessage } from '../types.ts';
import { HistoryStack } from '../history.ts';

const STORAGE_KEY = 'rsrouter_route';
const MAX_UNDO = 50;
const DEFAULT_AVOID_RADIUS_M = 30;

interface RouteHistorySnapshot {
  waypoints: LatLon[];
  avoidAreas: AvoidArea[];
}

function validPoint(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

function parseHash(): { waypoints: LatLon[]; profile?: ProfileName; avoidAreas: AvoidArea[] } | null {
  const raw = /(?:^#|&)r=([^&]*)/.exec(location.hash)?.[1];
  const rawNogos = /(?:^#|&)nogos=([^&]*)/.exec(location.hash)?.[1];
  if (!raw && !rawNogos) return null;
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
          radius: parts[2],
          weight: parts[3],
        });
      }
    }
  }
  const profile = /(?:^#|&)p=([^&]*)/.exec(location.hash)?.[1] as ProfileName | undefined;
  return {
    waypoints: points,
    profile: profile ? decodeURIComponent(profile) as ProfileName : undefined,
    avoidAreas: parsedAvoidAreas,
  };
}

function loadSavedRoute(): { waypoints: LatLon[]; profile?: ProfileName; avoidAreas?: AvoidArea[] } | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function useRouting(isOfflineMode: boolean) {
  const [profile, setProfileState] = useState<ProfileName>('fastbike-lowtraffic');
  const [waypoints, setWaypointsState] = useState<LatLon[]>([]);
  const [avoidAreas, setAvoidAreasState] = useState<AvoidArea[]>([]);
  const [currentRoute, setCurrentRoute] = useState<GeoJSON.FeatureCollection | null>(null);
  const [status, setStatus] = useState<string>('Click on the map to set start and end points.');
  const [isRouting, setIsRouting] = useState<boolean>(false);
  const [canUndo, setCanUndo] = useState<boolean>(false);
  const [canRedo, setCanRedo] = useState<boolean>(false);

  const historyRef = useRef(new HistoryStack<RouteHistorySnapshot>(MAX_UNDO));
  const workerRef = useRef<Worker | null>(null);
  const activeRouteIdRef = useRef<string | null>(null);
  const routeCounterRef = useRef<number>(0);

  const waypointsRef = useRef(waypoints);
  waypointsRef.current = waypoints;
  const avoidAreasRef = useRef(avoidAreas);
  avoidAreasRef.current = avoidAreas;
  const profileRef = useRef(profile);
  profileRef.current = profile;

  const updateUndoRedo = useCallback(() => {
    setCanUndo(historyRef.current.canUndo());
    setCanRedo(historyRef.current.canRedo());
  }, []);

  const saveToUrlAndStorage = useCallback((wps: LatLon[], prof: ProfileName, avoids: AvoidArea[]) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ waypoints: wps, profile: prof, avoidAreas: avoids }));
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
    parts.push(`p=${encodeURIComponent(prof)}`);
    if (avoids.length > 0) {
      const nogos = avoids
        .map((a) => `${a.lon.toFixed(5)},${a.lat.toFixed(5)},${Math.round(a.radius)}${a.weight !== undefined ? ',' + a.weight : ''}`)
        .join(';');
      parts.push(`nogos=${encodeURIComponent(nogos)}`);
    }
    history.replaceState(null, '', location.pathname + location.search + '#' + parts.join('&'));
  }, []);

  const requestRoute = useCallback((wps: LatLon[], prof: ProfileName, avoids: AvoidArea[]) => {
    if (wps.length < 2) {
      setCurrentRoute(null);
      setIsRouting(false);
      setStatus(wps.length === 1 ? 'Start point set. Click on the map to add the next point.' : 'Click on the map to set start and end points.');
      return;
    }
    if (!workerRef.current) return;

    setStatus('Requesting route...');
    setIsRouting(true);
    const id = String(++routeCounterRef.current);
    activeRouteIdRef.current = id;

    workerRef.current.postMessage({
      type: 'ROUTE_REQUEST',
      id,
      payload: {
        waypoints: wps,
        profile: prof,
        alternativeIdx: 0,
        nogos: avoids.length > 0 ? avoids : undefined,
      },
    } satisfies WorkerMessage);
  }, []);

  // Worker initialization and offline sync
  useEffect(() => {
    const worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const msg = e.data;
      switch (msg.type) {
        case 'STATUS':
          setStatus(msg.message);
          break;
        case 'ROUTE_SUCCESS': {
          if (msg.id !== activeRouteIdRef.current) break;
          setCurrentRoute(msg.payload);
          setIsRouting(false);
          setStatus('');
          break;
        }
        case 'ROUTE_ERROR': {
          if (msg.id !== activeRouteIdRef.current) break;
          setCurrentRoute(null);
          setIsRouting(false);
          setStatus(`Routing error: ${msg.error}`);
          break;
        }
      }
    };

    worker.postMessage({ type: 'SET_OFFLINE_MODE', offline: isOfflineMode } satisfies WorkerMessage);
    worker.postMessage({ type: 'INIT' } satisfies WorkerMessage);

    // Initial load from Hash or LocalStorage
    const fromLink = /(?:^#|&)(?:r|nogos)=/.test(location.hash);
    const initial = fromLink ? parseHash() : loadSavedRoute();
    if (initial) {
      const initWps = initial.waypoints || [];
      const initAvoids = initial.avoidAreas || [];
      const initProf = initial.profile || 'fastbike-lowtraffic';

      setWaypointsState(initWps);
      setAvoidAreasState(initAvoids);
      setProfileState(initProf);
      saveToUrlAndStorage(initWps, initProf, initAvoids);
      if (initWps.length >= 2) {
        requestRoute(initWps, initProf, initAvoids);
      }
    }

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []); // Run once

  // Sync offline mode with worker
  useEffect(() => {
    if (workerRef.current) {
      workerRef.current.postMessage({ type: 'SET_OFFLINE_MODE', offline: isOfflineMode } satisfies WorkerMessage);
    }
  }, [isOfflineMode]);

  const setWaypoints = useCallback((next: LatLon[], recordUndo = true) => {
    if (recordUndo) {
      historyRef.current.record({
        waypoints: waypointsRef.current.map((w) => ({ ...w })),
        avoidAreas: avoidAreasRef.current.map((a) => ({ ...a })),
      });
      updateUndoRedo();
    }
    setWaypointsState(next);
    saveToUrlAndStorage(next, profileRef.current, avoidAreasRef.current);
    requestRoute(next, profileRef.current, avoidAreasRef.current);
  }, [requestRoute, saveToUrlAndStorage, updateUndoRedo]);

  const setAvoidAreas = useCallback((next: AvoidArea[], recordUndo = true) => {
    if (recordUndo) {
      historyRef.current.record({
        waypoints: waypointsRef.current.map((w) => ({ ...w })),
        avoidAreas: avoidAreasRef.current.map((a) => ({ ...a })),
      });
      updateUndoRedo();
    }
    setAvoidAreasState(next);
    saveToUrlAndStorage(waypointsRef.current, profileRef.current, next);
    if (waypointsRef.current.length >= 2) {
      requestRoute(waypointsRef.current, profileRef.current, next);
    }
  }, [requestRoute, saveToUrlAndStorage, updateUndoRedo]);

  const setProfile = useCallback((next: ProfileName) => {
    setProfileState(next);
    saveToUrlAndStorage(waypointsRef.current, next, avoidAreasRef.current);
    if (waypointsRef.current.length >= 2) {
      requestRoute(waypointsRef.current, next, avoidAreasRef.current);
    }
  }, [requestRoute, saveToUrlAndStorage]);

  const addWaypoint = useCallback((p: LatLon, action?: 'start' | 'end' | 'via' | 'append') => {
    const wps = waypointsRef.current;
    let next: LatLon[];
    if (action === 'start') {
      next = wps.length === 0 ? [p] : [p, ...wps.slice(1)];
    } else if (action === 'end') {
      next = wps.length < 2 ? [...wps, p] : [...wps.slice(0, -1), p];
    } else {
      next = [...wps, p];
    }
    setWaypoints(next, true);
  }, [setWaypoints]);

  const moveWaypoint = useCallback((index: number, p: LatLon) => {
    const next = waypointsRef.current.map((w, i) => (i === index ? { ...w, lat: p.lat, lon: p.lon } : w));
    setWaypoints(next, true);
  }, [setWaypoints]);

  const removeWaypoint = useCallback((index: number) => {
    const next = waypointsRef.current.filter((_, i) => i !== index);
    setWaypoints(next, true);
  }, [setWaypoints]);

  const renameWaypoint = useCallback((index: number, name: string) => {
    const next = waypointsRef.current.map((w, i) => (i === index ? { ...w, name: name.trim() || undefined } : w));
    setWaypoints(next, false);
  }, [setWaypoints]);

  const reorderWaypoints = useCallback((fromIndex: number, toIndex: number) => {
    const next = [...waypointsRef.current];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    setWaypoints(next, true);
  }, [setWaypoints]);

  const addAvoidArea = useCallback((p: LatLon, radius = DEFAULT_AVOID_RADIUS_M) => {
    const next = [...avoidAreasRef.current, { lat: p.lat, lon: p.lon, radius }];
    setAvoidAreas(next, true);
  }, [setAvoidAreas]);

  const removeAvoidArea = useCallback((index: number) => {
    const next = avoidAreasRef.current.filter((_, i) => i !== index);
    setAvoidAreas(next, true);
  }, [setAvoidAreas]);

  const clearRoute = useCallback(() => {
    if (waypointsRef.current.length === 0 && avoidAreasRef.current.length === 0) return;
    historyRef.current.record({
      waypoints: waypointsRef.current.map((w) => ({ ...w })),
      avoidAreas: avoidAreasRef.current.map((a) => ({ ...a })),
    });
    updateUndoRedo();
    setWaypointsState([]);
    setAvoidAreasState([]);
    setCurrentRoute(null);
    saveToUrlAndStorage([], profileRef.current, []);
    setStatus('Route and avoid areas cleared.');
  }, [saveToUrlAndStorage, updateUndoRedo]);

  const undo = useCallback(() => {
    const currentSnap: RouteHistorySnapshot = {
      waypoints: waypointsRef.current.map((w) => ({ ...w })),
      avoidAreas: avoidAreasRef.current.map((a) => ({ ...a })),
    };
    const prev = historyRef.current.undo(currentSnap);
    if (!prev) return;
    setWaypointsState(prev.waypoints);
    setAvoidAreasState(prev.avoidAreas);
    saveToUrlAndStorage(prev.waypoints, profileRef.current, prev.avoidAreas);
    if (prev.waypoints.length >= 2) {
      requestRoute(prev.waypoints, profileRef.current, prev.avoidAreas);
    } else {
      setCurrentRoute(null);
      setStatus(prev.waypoints.length === 1 ? 'Start point set. Click on the map to add the next point.' : 'Click on the map to set start and end points.');
    }
    updateUndoRedo();
  }, [requestRoute, saveToUrlAndStorage, updateUndoRedo]);

  const redo = useCallback(() => {
    const currentSnap: RouteHistorySnapshot = {
      waypoints: waypointsRef.current.map((w) => ({ ...w })),
      avoidAreas: avoidAreasRef.current.map((a) => ({ ...a })),
    };
    const next = historyRef.current.redo(currentSnap);
    if (!next) return;
    setWaypointsState(next.waypoints);
    setAvoidAreasState(next.avoidAreas);
    saveToUrlAndStorage(next.waypoints, profileRef.current, next.avoidAreas);
    if (next.waypoints.length >= 2) {
      requestRoute(next.waypoints, profileRef.current, next.avoidAreas);
    } else {
      setCurrentRoute(null);
      setStatus(next.waypoints.length === 1 ? 'Start point set. Click on the map to add the next point.' : 'Click on the map to set start and end points.');
    }
    updateUndoRedo();
  }, [requestRoute, saveToUrlAndStorage, updateUndoRedo]);

  const clearWorkerGraph = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.postMessage({ type: 'CLEAR_GRAPH' } satisfies WorkerMessage);
    }
  }, []);

  return {
    profile,
    setProfile,
    waypoints,
    setWaypoints,
    avoidAreas,
    setAvoidAreas,
    currentRoute,
    status,
    setStatus,
    isRouting,
    canUndo,
    canRedo,
    addWaypoint,
    moveWaypoint,
    removeWaypoint,
    renameWaypoint,
    reorderWaypoints,
    addAvoidArea,
    removeAvoidArea,
    clearRoute,
    undo,
    redo,
    clearWorkerGraph,
  };
}
