/* tslint:disable */
/* eslint-disable */

export class WasmRouter {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Adds the part of a 5°×5° segment (e.g. "W5_N50") that lies inside a lon/lat box,
     * at cell resolution, without resolving edges yet. Returns the number of cells added.
     */
    add_rd5_box(data: Uint8Array, segment_name: string, min_lon: number, min_lat: number, max_lon: number, max_lat: number): number;
    /**
     * Adds a single 1°×1° square from RD5 byte data into the routing graph without resolving edges yet.
     */
    add_rd5_square(data: Uint8Array, lon_deg: number, lat_deg: number): number;
    /**
     * Clears the loaded routing graph.
     */
    clear_graph(): void;
    /**
     * Returns the number of edges currently loaded in the graph.
     */
    edge_count(): number;
    /**
     * Computes a route for given waypoints ("lon,lat|lon,lat") and returns a GeoJSON string.
     */
    find_route(waypoints_str: string, profile_name: string, alternative_idx: number, nogos_str?: string | null): string;
    /**
     * Computes a route for given waypoints ("lon,lat|lon,lat") and returns a GPX string.
     */
    find_route_gpx(waypoints_str: string, profile_name: string, alternative_idx: number, nogos_str?: string | null): string;
    /**
     * Loads the lookups.dat dictionary from a string.
     */
    load_lookups(text: string): void;
    /**
     * Loads a BRouter profile (.brf) text.
     */
    load_profile(name: string, content: string): void;
    /**
     * Loads all non-empty squares in a 5°×5° segment (e.g. "W5_N50" or "E0_N50") into the routing graph.
     */
    load_rd5_segment(data: Uint8Array, segment_name: string): number;
    /**
     * Loads a single 1°×1° square from RD5 byte data into the routing graph and resolves edges immediately.
     */
    load_rd5_square(data: Uint8Array, lon_deg: number, lat_deg: number): number;
    constructor();
    /**
     * Returns the number of nodes currently loaded in the graph.
     */
    node_count(): number;
    /**
     * Resolves target elevations and edge indices for the entire graph.
     */
    resolve_graph(): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmrouter_free: (a: number, b: number) => void;
    readonly wasmrouter_add_rd5_box: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly wasmrouter_add_rd5_square: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly wasmrouter_clear_graph: (a: number) => void;
    readonly wasmrouter_edge_count: (a: number) => number;
    readonly wasmrouter_find_route: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly wasmrouter_find_route_gpx: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly wasmrouter_load_lookups: (a: number, b: number, c: number) => [number, number];
    readonly wasmrouter_load_profile: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly wasmrouter_load_rd5_segment: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly wasmrouter_load_rd5_square: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly wasmrouter_new: () => number;
    readonly wasmrouter_node_count: (a: number) => number;
    readonly wasmrouter_resolve_graph: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
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
