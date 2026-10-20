declare module "@omnishell/shell.js" {
  export function createShell(options: {
    config: string;
    mount: HTMLElement;
    liveUpdates?: boolean;
    preload?: boolean;
  }): Promise<{ store: any; navigate: (href: string) => void }>;
}

declare module "@omnishell/vendor/ses.umd.min.js" {}

declare module "*route-domain.js" {
  import type {
    BreakdownRowModel,
    ComputedElevationModel,
    NoiseCategory,
    RoadCategory,
    SpeedLimitCategory,
    SurfaceCategory,
    TrafficCategory,
    Units,
  } from "./types.ts";

  export const SURFACE_META: Record<SurfaceCategory, { label: string; color: string }>;
  export const ROAD_META: Record<RoadCategory, { label: string; color: string }>;
  export const TRAFFIC_META: Record<TrafficCategory, { label: string; color: string }>;
  export const NOISE_META: Record<NoiseCategory, { label: string; color: string }>;
  export const SPEED_LIMIT_META: Record<SpeedLimitCategory, { label: string; color: string }>;

  export function classifySurface(surface?: string, highway?: string): SurfaceCategory;
  export function classifyRoad(highway?: string): RoadCategory;
  export function classifyTraffic(traffic?: number, highway?: string): TrafficCategory;
  export function classifyNoise(noise?: number): NoiseCategory;
  export function classifySpeedLimit(maxspeed?: number, highway?: string): SpeedLimitCategory;

  export function formatDistance(meters: number, units?: Units): string;
  export function formatElevation(meters: number, units?: Units): string;
  export function formatDuration(seconds: number): string;
  export function formatSpeed(meters: number, seconds: number, units?: Units): string;

  export class HistoryStack<T> {
    constructor(maxDepth?: number);
    record(currentState: T): void;
    undo(currentState: T): T | null;
    redo(currentState: T): T | null;
    canUndo(): boolean;
    canRedo(): boolean;
    clear(): void;
  }

  export function computeFilteredElevation(ele: number[]): { ascentM: number; descentM: number };
  export function routeToGpx(geojson: GeoJSON.FeatureCollection, trackName: string): string;

  export function buildElevationChartModel(
    routeGeoJson: GeoJSON.FeatureCollection | null,
    units: Units,
    slotIdx: number,
    compact: boolean,
  ): ComputedElevationModel | null;

  export function computeHoverReadout(
    model: ComputedElevationModel,
    frac: number,
    units?: Units,
  ): {
    pt: { lon: number; lat: number; ele: number; dist: number; grade: number };
    cx: number;
    cy: number;
    gradeColor: string;
    fields: Record<string, string>;
  };

  export function buildSurfaceBreakdownModel(
    routeGeoJson: GeoJSON.FeatureCollection | null,
    units: Units,
    activeHighlight: { rowTitle: string; label: string } | null,
  ): { specJson: string; rows: BreakdownRowModel[] };
}

