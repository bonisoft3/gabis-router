export type ProfileName = 'fastbike' | 'fastbike-lowtraffic' | 'fastbike-verylowtraffic';

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
      coordinates: [number, number, number?][];
    };
  }>;
}

export type WorkerMessage =
  | { type: 'INIT'; payload: { segmentUrls: string[] } }
  | { type: 'ROUTE_REQUEST'; id: string; payload: RouteRequest }
  | { type: 'ROUTE_SUCCESS'; id: string; payload: RouteResponse }
  | { type: 'ROUTE_ERROR'; id: string; error: string }
  | { type: 'STATUS'; message: string };
