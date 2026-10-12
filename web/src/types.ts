export type ProfileName = 'fastbike' | 'fastbike-lowtraffic' | 'fastbike-verylowtraffic' | 'gabis-lite-gravel' | 'gabis-safe-road' | 'gravel' | 'trekking';

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

export type WorkerMessage =
  | { type: 'INIT' }
  | { type: 'ROUTE_REQUEST'; id: string; payload: RouteRequest }
  | { type: 'ROUTE_SUCCESS'; id: string; payload: RouteResponse }
  | { type: 'ROUTE_ERROR'; id: string; error: string }
  | { type: 'STATUS'; message: string }
  | { type: 'CLEAR_GRAPH' }
  | { type: 'SET_OFFLINE_MODE'; offline: boolean };
