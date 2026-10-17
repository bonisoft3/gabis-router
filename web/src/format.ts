// Number formatting with a metric or imperial setting. The setting is saved.

export type Units = 'metric' | 'imperial';

const STORAGE_KEY = 'rsrouter_units';
const M_PER_MILE = 1609.344;
const FT_PER_M = 3.28084;

function defaultUnits(): Units {
  // Roads in the UK and the US use miles.
  return ['en-US', 'en-GB'].includes(navigator.language) ? 'imperial' : 'metric';
}

let units: Units = (localStorage.getItem(STORAGE_KEY) as Units | null) ?? defaultUnits();
const listeners: Array<() => void> = [];

export function getUnits(): Units {
  return units;
}

export function setUnits(next: Units) {
  if (next === units) return;
  units = next;
  localStorage.setItem(STORAGE_KEY, next);
  listeners.forEach((fn) => fn());
}

/** Calls `fn` after the units change. Returns an unsubscribe function. */
export function onUnitsChange(fn: () => void): () => void {
  listeners.push(fn);
  return () => {
    const idx = listeners.indexOf(fn);
    if (idx !== -1) listeners.splice(idx, 1);
  };
}

export function formatDistance(meters: number): string {
  if (units === 'imperial') {
    const miles = meters / M_PER_MILE;
    return `${miles.toFixed(miles < 10 ? 2 : 1)} mi`;
  }
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(meters < 10000 ? 2 : 1)} km`;
}

export function formatElevation(meters: number): string {
  return units === 'imperial' ? `${Math.round(meters * FT_PER_M)} ft` : `${Math.round(meters)} m`;
}

export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

export function formatSpeed(meters: number, seconds: number): string {
  if (seconds <= 0 || meters <= 0) return units === 'imperial' ? '0.0 mph' : '0.0 km/h';
  const hours = seconds / 3600;
  if (units === 'imperial') {
    const mph = meters / M_PER_MILE / hours;
    return `${mph.toFixed(1)} mph`;
  }
  const kmh = meters / 1000 / hours;
  return `${kmh.toFixed(1)} km/h`;
}

