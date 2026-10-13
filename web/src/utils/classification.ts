// Route segment tagging and surface / infrastructure classifications.

export interface SegmentHighlight {
  coordinates: number[][][];
  color: string;
}

export interface SegmentData {
  from: number;
  to: number;
  surface: string;
  highway: string;
  noise?: number;
  traffic?: number;
  maxspeed?: number;
}

export type SurfaceCategory = 'paved' | 'unpaved' | 'gravel' | 'trail' | 'cobblestone' | 'unknown';

export const SURFACE_META: Record<SurfaceCategory, { label: string; color: string }> = {
  paved: { label: 'Paved', color: '#10b981' },
  gravel: { label: 'Gravel', color: '#f59e0b' },
  unpaved: { label: 'Unpaved', color: '#d97706' },
  trail: { label: 'Trail', color: '#854d0e' },
  cobblestone: { label: 'Cobblestone', color: '#8b5cf6' },
  unknown: { label: 'Unknown', color: '#94a3b8' },
};

export function classifySurface(surface?: string, highway?: string): SurfaceCategory {
  const s = (surface || '').toLowerCase().trim();
  const h = (highway || '').toLowerCase().trim();

  // 1. Explicit surface tags
  if (['asphalt', 'paved', 'concrete', 'concrete:lanes', 'concrete:plates', 'tarmac'].includes(s)) {
    return 'paved';
  }
  if (['cobblestone', 'cobblestone:flattened', 'sett', 'paving_stones'].includes(s)) {
    return 'cobblestone';
  }
  if (['gravel', 'fine_gravel', 'compacted', 'pebblestone'].includes(s)) {
    return 'gravel';
  }
  if (['dirt', 'earth', 'ground', 'mud', 'sand', 'clay'].includes(s)) {
    return 'trail';
  }
  if (['unpaved', 'wood', 'metal', 'grass', 'grass_paver'].includes(s)) {
    return 'unpaved';
  }

  // 2. Inferred from highway when surface tag is absent
  if (['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'living_street', 'service', 'cycleway', 'pedestrian'].includes(h)) {
    return 'paved';
  }
  if (h === 'track') {
    return 'gravel';
  }
  if (['path', 'footway', 'bridleway', 'steps'].includes(h)) {
    return 'trail';
  }

  return 'unknown';
}

export type RoadCategory = 'cycleway' | 'quiet' | 'minor' | 'major' | 'path' | 'unknown';

export const ROAD_META: Record<RoadCategory, { label: string; color: string }> = {
  cycleway: { label: 'Cycleway', color: '#06b6d4' },
  quiet: { label: 'Quiet street', color: '#10b981' },
  minor: { label: 'Minor road', color: '#f59e0b' },
  major: { label: 'Major road', color: '#ef4444' },
  path: { label: 'Path / Trail', color: '#854d0e' },
  unknown: { label: 'Unknown', color: '#94a3b8' },
};

export function classifyRoad(highway?: string): RoadCategory {
  const h = (highway || '').toLowerCase().trim();
  if (h === 'cycleway') return 'cycleway';
  if (['residential', 'living_street', 'service', 'unclassified', 'pedestrian'].includes(h)) return 'quiet';
  if (['tertiary', 'tertiary_link'].includes(h)) return 'minor';
  if (['secondary', 'secondary_link', 'primary', 'primary_link', 'trunk', 'trunk_link', 'motorway', 'motorway_link'].includes(h)) return 'major';
  if (['path', 'footway', 'bridleway', 'track', 'steps'].includes(h)) return 'path';
  return 'unknown';
}

export type TrafficCategory = 'traffic_free' | 'low' | 'acceptable' | 'heavy';

export const TRAFFIC_META: Record<TrafficCategory, { label: string; color: string }> = {
  traffic_free: { label: 'Traffic-free', color: '#059669' },
  low: { label: 'Low', color: '#84cc16' },
  acceptable: { label: 'Acceptable', color: '#f59e0b' },
  heavy: { label: 'Heavy', color: '#ef4444' },
};

export function classifyTraffic(traffic?: number, highway?: string): TrafficCategory {
  const h = (highway || '').toLowerCase().trim();
  if (['cycleway', 'path', 'footway', 'pedestrian', 'bridleway', 'track', 'steps'].includes(h)) {
    return 'traffic_free';
  }
  const t = traffic || 0;
  if (t >= 4) return 'heavy';
  if (t >= 2) return 'acceptable';
  return 'low';
}

export type NoiseCategory = 'very_quiet' | 'moderate' | 'loud';

export const NOISE_META: Record<NoiseCategory, { label: string; color: string }> = {
  very_quiet: { label: 'Low', color: '#10b981' },
  moderate: { label: 'Moderate', color: '#f59e0b' },
  loud: { label: 'High', color: '#ef4444' },
};

export function classifyNoise(noise?: number): NoiseCategory {
  const n = noise || 0;
  if (n >= 4) return 'loud';
  if (n >= 2) return 'moderate';
  return 'very_quiet';
}

export type SpeedLimitCategory =
  | 'car_free'
  | '20mph'
  | '30mph'
  | '40mph'
  | '50mph'
  | '60mph'
  | '70mph';

export const SPEED_LIMIT_META: Record<SpeedLimitCategory, { label: string; color: string }> = {
  car_free: { label: 'Car-free', color: '#059669' },
  '20mph': { label: '20 mph', color: '#10b981' },
  '30mph': { label: '30 mph', color: '#84cc16' },
  '40mph': { label: '40 mph', color: '#eab308' },
  '50mph': { label: '50 mph', color: '#f97316' },
  '60mph': { label: '60 mph', color: '#ef4444' },
  '70mph': { label: '70 mph', color: '#991b1b' },
};

export function classifySpeedLimit(maxspeed?: number, highway?: string): SpeedLimitCategory {
  const h = (highway || '').toLowerCase().trim();

  // 1. Car-free routes and paths
  if (['cycleway', 'path', 'footway', 'pedestrian', 'bridleway', 'track', 'steps'].includes(h)) {
    return 'car_free';
  }

  // 2. Explicit speed limits (in km/h as encoded in RD5 / BRouter)
  if (maxspeed && maxspeed > 0) {
    if (maxspeed <= 35) return '20mph';
    if (maxspeed <= 55) return '30mph';
    if (maxspeed <= 75) return '40mph';
    if (maxspeed <= 95) return '50mph';
    if (maxspeed <= 105) return '60mph';
    return '70mph';
  }

  // 3. Fallback inference based on highway classification when untagged
  if (['residential', 'living_street', 'service'].includes(h)) {
    return '20mph';
  }
  if (['tertiary', 'tertiary_link', 'unclassified'].includes(h)) {
    return '30mph';
  }
  if (['secondary', 'secondary_link'].includes(h)) {
    return '40mph';
  }
  if (['primary', 'primary_link'].includes(h)) {
    return '50mph';
  }
  if (['trunk', 'trunk_link'].includes(h)) {
    return '60mph';
  }
  if (['motorway', 'motorway_link'].includes(h)) {
    return '70mph';
  }

  return '30mph';
}

