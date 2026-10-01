export type ProfileName = 'fastbike' | 'fastbike-lowtraffic' | 'fastbike-verylowtraffic' | 'trekking';

export interface LatLon {
  lat: number;
  lon: number;
}

export interface RouteRequest {
  waypoints: LatLon[];
  profile: ProfileName;
  alternativeIdx?: number;
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

export type SegmentStatus = 'available' | 'downloading' | 'cached';

export interface SegmentInfo {
  id: string; // e.g. 'W5_N50'
  name: string; // e.g. 'England & Wales'
  bbox: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
  sizeMb: number;
  status: SegmentStatus;
  cachedBytes?: number;
}

export type WorkerMessage =
  | { type: 'INIT'; payload: { segmentUrls: string[] } }
  | { type: 'ROUTE_REQUEST'; id: string; payload: RouteRequest }
  | { type: 'ROUTE_SUCCESS'; id: string; payload: RouteResponse }
  | { type: 'ROUTE_ERROR'; id: string; error: string }
  | { type: 'STATUS'; message: string }
  | { type: 'CACHE_STATUS_REQUEST' }
  | { type: 'CACHE_STATUS_RESPONSE'; segments: Record<string, { cached: boolean; sizeBytes: number }> }
  | { type: 'DOWNLOAD_SEGMENT'; segmentId: string }
  | { type: 'DOWNLOAD_PROGRESS'; segmentId: string; message: string }
  | { type: 'DOWNLOAD_COMPLETE'; segmentId: string; sizeBytes: number }
  | { type: 'DOWNLOAD_ERROR'; segmentId: string; error: string }
  | { type: 'DELETE_SEGMENT'; segmentId: string }
  | { type: 'DELETE_COMPLETE'; segmentId: string }
  | { type: 'SET_OFFLINE_MODE'; offline: boolean };
