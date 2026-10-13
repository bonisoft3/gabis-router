// Geodesic calculations, distance metrics, and elevation profile modeling.

import type { LatLon } from '../types.ts';

const R_EARTH = 6371000;
const GRADE_WINDOW_M = 40;

export interface Profile {
  /** Distance from start in meters, per vertex */
  dist: number[];
  /** Elevation in meters, per vertex */
  ele: number[];
  coords: number[][];
}

export function haversine(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}

export function distanceMeters(a: LatLon, b: LatLon): number {
  return haversine(a.lat, a.lon, b.lat, b.lon);
}

export function createCirclePolygon(
  center: LatLon,
  radiusMeters: number,
  points = 32,
): number[][] {
  const coords: number[][] = [];
  const latRad = (center.lat * Math.PI) / 180;
  const dLat = (radiusMeters / R_EARTH) * (180 / Math.PI);
  const dLon = (radiusMeters / (R_EARTH * Math.cos(latRad))) * (180 / Math.PI);
  for (let i = 0; i <= points; i++) {
    const theta = (i / points) * 2 * Math.PI;
    coords.push([
      center.lon + dLon * Math.sin(theta),
      center.lat + dLat * Math.cos(theta),
    ]);
  }
  return coords;
}

export function projectedDistanceSq(a: number[], lon: number, lat: number): number {
  const dx = (a[0] - lon) * Math.cos((lat * Math.PI) / 180);
  const dy = a[1] - lat;
  return dx * dx + dy * dy;
}

export function nearestVertex(
  coords: number[][],
  lon: number,
  lat: number,
  from = 0,
): number {
  let best = from;
  let bestDist = Infinity;
  for (let i = from; i < coords.length; i++) {
    const d = projectedDistanceSq(coords[i], lon, lat);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

export function nearestIndex(dist: number[], d: number): number {
  let lo = 0;
  let hi = dist.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dist[mid] < d) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && d - dist[lo - 1] < dist[lo] - d ? lo - 1 : lo;
}

export function gradeAt(dist: number[], ele: number[], i: number): number {
  const a = nearestIndex(dist, dist[i] - GRADE_WINDOW_M);
  const b = nearestIndex(dist, dist[i] + GRADE_WINDOW_M);
  const run = dist[b] - dist[a];
  return run > 0 ? ((ele[b] - ele[a]) / run) * 100 : 0;
}

export function gradeColor(grade: number): string {
  if (grade < -1) return '#38bdf8'; // light blue: downhill
  if (grade <= 3) return '#22c55e'; // green: flat / mild
  if (grade <= 6) return '#eab308'; // yellow: gentle climb
  if (grade <= 9) return '#f97316'; // orange: moderate climb
  return '#ef4444'; // red: steep climb
}

/**
 * Builds cumulative distance array and performs elevation smoothing across water crossings
 * where raw DEM sensors drop abruptly to sea level (0 m).
 */
export function buildProfile(coords: number[][]): Profile {
  const dist = [0];
  for (let i = 1; i < coords.length; i++) {
    const prev = coords[i - 1];
    const curr = coords[i];
    dist.push(dist[i - 1] + haversine(prev[1], prev[0], curr[1], curr[0]));
  }
  const ele = coords.map((c) => c[2] ?? 0);

  // Smooth intermediate runs of 0 m across bridges
  let i = 0;
  while (i < ele.length) {
    if (ele[i] === 0) {
      let j = i;
      while (j < ele.length && ele[j] === 0) j++;

      const hasLeft = i > 0;
      const hasRight = j < ele.length;

      if (hasLeft && hasRight) {
        const leftEle = ele[i - 1];
        const rightEle = ele[j];
        const leftDist = dist[i - 1];
        const rightDist = dist[j];
        const span = rightDist - leftDist;
        if (span > 0) {
          for (let k = i; k < j; k++) {
            const t = (dist[k] - leftDist) / span;
            ele[k] = leftEle + t * (rightEle - leftEle);
          }
        }
      } else if (hasLeft) {
        for (let k = i; k < j; k++) {
          ele[k] = ele[i - 1];
        }
      } else if (hasRight) {
        for (let k = i; k < j; k++) {
          ele[k] = ele[j];
        }
      }
      i = j;
    } else {
      i++;
    }
  }

  return { dist, ele, coords };
}
