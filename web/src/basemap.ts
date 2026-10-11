// Basemap style setting: standard vector map, CyclOSM, or OpenCycleMap.

export type Basemap = 'standard' | 'cyclosm' | 'opencyclemap';
export type BasemapSetting = Basemap;

const STORAGE_KEY = 'rsrouter_basemap';
const API_KEY_STORAGE = 'rsrouter_thunderforest_key';
export const DEFAULT_THUNDERFOREST_KEY = String((import.meta as any).env?.VITE_THUNDERFOREST_KEY || '').trim();

const listeners: Array<() => void> = [];

let basemap: Basemap = (() => {
  const stored = localStorage.getItem(STORAGE_KEY) as string | null;
  if (stored === 'cyclosm' || stored === 'opencyclemap') return stored;
  return 'standard';
})();

const customStoredKey = localStorage.getItem(API_KEY_STORAGE);
let thunderforestKey: string = customStoredKey ? customStoredKey : DEFAULT_THUNDERFOREST_KEY;

export function getBasemap(): Basemap {
  return basemap;
}

export function setBasemap(next: Basemap) {
  if (basemap === next) return;
  basemap = next;
  localStorage.setItem(STORAGE_KEY, next);
  listeners.forEach((fn) => fn());
}

export function getThunderforestKey(): string {
  return thunderforestKey;
}

export function setThunderforestKey(key: string) {
  const trimmed = key.trim();
  const nextKey = trimmed || DEFAULT_THUNDERFOREST_KEY;
  if (thunderforestKey === nextKey) {
    if (!trimmed) localStorage.removeItem(API_KEY_STORAGE);
    return;
  }
  thunderforestKey = nextKey;
  if (trimmed && trimmed !== DEFAULT_THUNDERFOREST_KEY) {
    localStorage.setItem(API_KEY_STORAGE, trimmed);
  } else {
    localStorage.removeItem(API_KEY_STORAGE);
  }
  if (basemap === 'opencyclemap') {
    listeners.forEach((fn) => fn());
  }
}

/** Calls `fn` after the basemap style or its configuration changes. */
export function onBasemapChange(fn: () => void) {
  listeners.push(fn);
}
