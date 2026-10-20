/* tslint:disable */
/* eslint-disable */

export class WasmRouter {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Clears the loaded routing graph and segment index caches while preserving any attached lazy `CellProvider`.
     */
    clear_graph(): void;
    /**
     * Returns the number of edges currently loaded in the graph.
     */
    edge_count(): number;
    /**
     * Loads the lookups.dat dictionary from a string.
     */
    load_lookups(text: string): void;
    /**
     * Loads a BRouter profile (.brf) text.
     */
    load_profile(name: string, content: string): void;
    /**
     * Returns the number of `MicroCache` cells currently decoded in the graph.
     */
    loaded_cell_count(): number;
    /**
     * Snaps a GPX XML track to the road network, extracts the minimal set of waypoints
     * required to reproduce the track within `tolerance_m` for `profile_name`, and returns
     * a JSON string `{ "waypoints": [{"lon": ..., "lat": ...}], "route": <GeoJSON> }`.
     */
    match_gpx_waypoints(gpx_xml: string, profile_name: string, tolerance_m: number): string;
    constructor();
    /**
     * Returns the number of nodes currently loaded in the graph.
     */
    node_count(): number;
    /**
     * Computes a route for given waypoints ("lon,lat|lon,lat") and returns a GeoJSON string.
     */
    route(waypoints_str: string, profile_name: string, alternative_idx: number, nogos_str?: string | null): string;
    /**
     * Attaches JS callbacks `(size_fn(name) -> number, read_fn(name, start, end) -> Uint8Array)`
     * for BRouter-style lazy on-demand `MicroCache` cell loading during waypoint snapping and A* search.
     */
    set_segment_reader(size_fn: Function, read_fn: Function): void;
    /**
     * Drains and returns the names of any `.rd5` segments (e.g. `"W5_N50"`) that were requested
     * during lazy cell loading while not yet available in the Worker's Blob map.
     */
    take_missing_segments(): string[];
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmrouter_free: (a: number, b: number) => void;
    readonly wasmrouter_clear_graph: (a: number) => void;
    readonly wasmrouter_edge_count: (a: number) => number;
    readonly wasmrouter_load_lookups: (a: number, b: number, c: number) => [number, number];
    readonly wasmrouter_load_profile: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly wasmrouter_loaded_cell_count: (a: number) => number;
    readonly wasmrouter_match_gpx_waypoints: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly wasmrouter_new: () => number;
    readonly wasmrouter_node_count: (a: number) => number;
    readonly wasmrouter_route: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly wasmrouter_set_segment_reader: (a: number, b: any, c: any) => void;
    readonly wasmrouter_take_missing_segments: (a: number) => [number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
