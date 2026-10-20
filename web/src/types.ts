export type ProfileName =
  | 'fastbike'
  | 'fastbike-lowtraffic'
  | 'fastbike-verylowtraffic'
  | 'gabis-fast-city'
  | 'gabis-lite-gravel'
  | 'gabis-safe-road'
  | 'gravel'
  | 'trekking';

export interface ProfileMeta {
  id: ProfileName;
  label: string;
  shortLabel: string;
  summary: string;
}

export const PROFILE_INFO: Record<ProfileName, ProfileMeta> = {
  'fastbike-lowtraffic': {
    id: 'fastbike-lowtraffic',
    label: 'Fastbike Low Traffic',
    shortLabel: 'Low Traffic',
    summary: 'Paved roads, avoids heavy traffic, balanced climbing.',
  },
  'fastbike-verylowtraffic': {
    id: 'fastbike-verylowtraffic',
    label: 'Fastbike Very Low Traffic',
    shortLabel: 'Very Low Traffic',
    summary: 'Quiet country lanes and backroads, strong traffic avoidance.',
  },
  fastbike: {
    id: 'fastbike',
    label: 'Fastbike',
    shortLabel: 'Fastbike',
    summary: 'Direct paved road routing for speed, allows busier roads.',
  },
  'gabis-safe-road': {
    id: 'gabis-safe-road',
    label: "Gabi's Safe Road",
    shortLabel: 'Safe Road',
    summary: 'Protected cycleways and quiet residential streets, avoids fast traffic.',
  },
  'gabis-fast-city': {
    id: 'gabis-fast-city',
    label: "Gabi's Fast City",
    shortLabel: 'Fast City',
    summary: 'Direct urban cycle routes and bus/cycle lanes, avoids residential zig-zags.',
  },
  'gabis-lite-gravel': {
    id: 'gabis-lite-gravel',
    label: "Gabi's Lite Gravel",
    shortLabel: 'Lite Gravel',
    summary: 'Quiet lanes mixed with compact gravel tracks and towpaths.',
  },
  gravel: {
    id: 'gravel',
    label: 'Gravel',
    shortLabel: 'Gravel',
    summary: 'Prefers unpaved tracks, bridleways, and off-road trails.',
  },
  trekking: {
    id: 'trekking',
    label: 'Trekking',
    shortLabel: 'Trekking',
    summary: 'Touring and utility cycling on cycle paths and gentle gradients.',
  },
};

export const PROFILE_ORDER: ProfileName[] = [
  'fastbike-lowtraffic',
  'fastbike-verylowtraffic',
  'gabis-safe-road',
  'gabis-fast-city',
  'fastbike',
  'gabis-lite-gravel',
  'gravel',
  'trekking',
];

export interface LatLon {
  lat: number;
  lon: number;
  name?: string;
}

export interface AvoidArea {
  lat: number;
  lon: number;
  radius: number;
  weight?: number;
}

export const MAX_ROUTE_SLOTS = 3;

export const ROUTE_SLOT_COLORS = [
  { line: '#3b82f6', casing: '#1e40af', soft: 'rgba(59, 130, 246, 0.14)', name: 'Blue' },
  { line: '#a855f7', casing: '#6b21a8', soft: 'rgba(168, 85, 247, 0.14)', name: 'Purple' },
  { line: '#f97316', casing: '#9a3412', soft: 'rgba(249, 115, 22, 0.14)', name: 'Orange' },
] as const;

export interface RouteSlotState {
  profile: ProfileName;
  alternativeIdx: number;
  route: GeoJSON.FeatureCollection | null;
  isRouting: boolean;
}

export interface RouteRequest {
  waypoints: LatLon[];
  profile: ProfileName;
  alternativeIdx?: number;
  nogos?: AvoidArea[];
}

export interface RouteResponse {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    properties: {
      'track-length': string;
      'total-time': string;
      cost: string;
      'filtered ascend': string;
      [key: string]: unknown;
    };
    geometry: {
      type: 'LineString';
      coordinates: number[][];
    };
  }>;
}

export interface ImportGpxRequest {
  gpxXml: string;
  profile: ProfileName;
  toleranceM?: number;
}

export interface ImportGpxResponse {
  waypoints: LatLon[];
  route: RouteResponse;
}

export type WorkerMessage =
  | { type: 'INIT' }
  | { type: 'ROUTE_REQUEST'; id: string; slotIdx?: number; payload: RouteRequest }
  | { type: 'ROUTE_SUCCESS'; id: string; slotIdx?: number; payload: RouteResponse }
  | { type: 'IMPORT_GPX_REQUEST'; id: string; payload: ImportGpxRequest }
  | { type: 'IMPORT_GPX_SUCCESS'; id: string; payload: ImportGpxResponse }
  | { type: 'ROUTE_ERROR'; id: string; slotIdx?: number; error: string }
  | { type: 'STATUS'; message: string }
  | { type: 'CLEAR_GRAPH' }
  | { type: 'SET_OFFLINE_MODE'; offline: boolean };

export const AVOID_RADIUS_PRESETS = [50, 100, 250, 500];

export function waypointKind(i: number, n: number): 'start' | 'end' | 'via' {
  if (i === 0) return 'start';
  return i === n - 1 ? 'end' : 'via';
}

export function waypointLabel(i: number, n: number): string {
  const kind = waypointKind(i, n);
  return kind === 'start' ? 'A' : kind === 'end' ? 'B' : String(i);
}

