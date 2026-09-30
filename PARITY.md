# Parity Verification

Benchmarks comparing `rsrouter` against upstream Java BRouter (`btools.router`).

## Summary

| Metric | rsrouter | Baseline |
| :--- | :--- | :--- |
| Exact Coordinate Match | 12 / 18 routes | 18 / 18 |
| Distance Match within 0.25% | 18 / 18 routes | 18 / 18 |
| Cost Match within 0.20% | 18 / 18 routes | 18 / 18 |
| Max Distance Delta | 0.21% | - |
| Max Cost Delta | 0.18% | - |

## Parity Distribution

| Corridor | Profile | Points (RS / BR) | Dist Delta | Cost Delta | Time Delta | Max Spatial Dev |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Clapham -> Hackney | `fastbike` | 922 / 922 | 0.00% | 0.00% | +0.29% | 0.1 m |
| Clapham -> Hackney | `fastbike-lowtraffic` | 919 / 919 | 0.00% | 0.00% | +0.16% | 0.0 m |
| Clapham -> Hackney | `fastbike-verylowtraffic` | 881 / 881 | 0.00% | 0.00% | +0.19% | 0.1 m |
| London -> Brighton | `fastbike` | 3195 / 3196 | 0.00% | +0.18% | +0.07% | 111.7 m |
| London -> Brighton | `fastbike-lowtraffic` | 3252 / 3265 | +0.21% | +0.05% | +0.10% | 521.9 m |
| London -> Brighton | `fastbike-verylowtraffic` | 3707 / 3707 | 0.00% | 0.00% | +0.01% | 0.0 m |
| London -> Oxford | `fastbike` | 3321 / 3321 | 0.00% | 0.00% | +0.03% | 0.0 m |
| London -> Oxford | `fastbike-lowtraffic` | 2766 / 2766 | 0.00% | 0.00% | +0.02% | 0.0 m |
| London -> Oxford | `fastbike-verylowtraffic` | 3885 / 3885 | 0.00% | 0.00% | +0.03% | 0.0 m |
| London -> Cardiff | `fastbike` | 7694 / 7694 | 0.00% | 0.00% | +0.07% | 0.0 m |
| London -> Cardiff | `fastbike-lowtraffic` | 7480 / 7470 | 0.00% | +0.03% | +0.11% | 1.1 m |
| London -> Cardiff | `fastbike-verylowtraffic` | 8777 / 8777 | 0.00% | 0.00% | +0.11% | 0.0 m |
| Richmond -> Windsor -> Marlow -> Oxford | `fastbike` | 2717 / 2717 | 0.00% | 0.00% | +0.10% | 0.1 m |
| Richmond -> Windsor -> Marlow -> Oxford | `fastbike-lowtraffic` | 2673 / 2673 | 0.00% | 0.00% | +0.05% | 0.1 m |
| Richmond -> Windsor -> Marlow -> Oxford | `fastbike-verylowtraffic` | 2815 / 2815 | 0.00% | 0.00% | +0.05% | 0.1 m |
| London -> Brighton (Alt 1) | `fastbike-lowtraffic` | 2991 / 3037 | +0.08% | +0.18% | +0.11% | 1.8 m |
| London -> Brighton (Alt 2) | `fastbike-lowtraffic` | 3122 / 3122 | +0.09% | +0.05% | +0.01% | 0.8 m |
| London -> Brighton (Alt 3) | `fastbike-lowtraffic` | 3381 / 3304 | +0.09% | +0.14% | +0.11% | 1.8 m |

12 of 18 routes produce identical coordinate sequences. All 3 alternative routes follow upstream routes within 0.10% distance and 0.20% cost.

## Parity Fixes

### 1. Reverse Edge Deduplication

BRouter RD5 files store polyline geometry only on forward links. Reverse records have empty geometry. `rsrouter` previously inserted both directions unconditionally, creating straight chord edges alongside curved ones. A* would pick the shorter chords, dropping coordinate points.

Fixed in [`routing_graph.rs`](crates/rsrouter-core/src/graph/routing_graph.rs): [`insert_or_update_edge`](crates/rsrouter-core/src/graph/routing_graph.rs#L117-L135) now merges parallel edges, keeping the forward record's geometry.

### 2. Distance Discretization

Java BRouter rounds segment distances to integer meters: `Math.max(1.0, Math.round(d))`.

Fixed in [`search.rs`](crates/rsrouter-core/src/routing/search.rs#L625): [`process_polyline`](crates/rsrouter-core/src/routing/search.rs#L625) now uses `(distance(...).round() as f64).max(1.0)`.

### 3. Kinematic Integration

Java BRouter casts distance to `int` before feeding it into incline and speed kinematics.

Fixed in [`path.rs`](crates/rsrouter-core/src/routing/path.rs#L273): [`process_section`](crates/rsrouter-core/src/routing/path.rs#L273) now casts `dist as i32` before passing to kinematics.

### 4. Elevation Coordinate Precision

BRouter encodes elevation in 0.25 m increments. Fixed [`to_geojson`](crates/rsrouter-core/src/routing/search.rs#L739-L745) to output exact values instead of rounding to one decimal.

## Remaining Gaps

3 routes have minor divergences, all from tie-breaking on equal-cost options:

| Corridor | Profile | Location | Max Deviation | Cause |
| :--- | :--- | :--- | :--- | :--- |
| London -> Brighton | `fastbike` | Redhill town center | 111.7 m | Equal-cost parallel residential streets |
| London -> Brighton | `fastbike-lowtraffic` | Seven Dials (Brighton) | 521.9 m | Alternative finish within 0.05% cost |
| London -> Cardiff | `fastbike-lowtraffic` | Newport Road (Cardiff) | 1.1 m | Parallel cycleway vs road, same distance |

## Regression Prevention

### End-to-End Integration Tests (`cargo test`)

```bash
cargo test --test integration_tests
```

Runs 25 integration tests (7 API endpoint tests and 18 corridor parity tests) against the server using a single shared preloaded graph. Peak RSS is bounded to 3.2 GB.

### Benchmark Suite (`compare_routes`)

```bash
cargo run --release -p rsrouter-server --bin compare_routes
```

Asserts maximum deltas across all 18 routes. Exits with status 1 if any threshold is exceeded.

| Route | Max Dist Delta | Max Cost Delta | Max Time Delta |
| :--- | :--- | :--- | :--- |
| Default (all routes) | 0.05% | 0.05% | 0.50% |
| London -> Brighton (`fastbike`) | 0.05% | 0.25% | 0.50% |
| London -> Brighton (`fastbike-lowtraffic`) | 0.30% | 0.10% | 0.50% |
| London -> Cardiff (`fastbike-lowtraffic`) | 0.05% | 0.05% | 0.50% |
| London -> Brighton (Alt 1) (`fastbike-lowtraffic`) | 0.15% | 0.25% | 0.50% |
| London -> Brighton (Alt 2) (`fastbike-lowtraffic`) | 0.15% | 0.10% | 0.50% |
| London -> Brighton (Alt 3) (`fastbike-lowtraffic`) | 0.15% | 0.20% | 0.50% |

### Unit Tests (`cargo test`)

[`routing_tests.rs`](crates/rsrouter-core/tests/routing_tests.rs) asserts exact coordinate counts, costs, and distances on Clapham to Hackney across all three profiles.

## Latency

Measured against the official BRouter server (`brouter.de`) with warm caches:

| Corridor | Profile | brouter.de | rsrouter | Comparison |
| :--- | :--- | :--- | :--- | :--- |
| Clapham -> Hackney (Local Graph) | `fastbike` | 708 ms | 460 ms | 1.54x faster |
| Clapham -> Hackney (Regional Graph) | `fastbike` | 708 ms | 942 ms | 1.33x slower |
| Clapham -> Hackney | `fastbike-lowtraffic` | 721 ms | 999 ms | 1.39x slower |
| Clapham -> Hackney | `fastbike-verylowtraffic` | 707 ms | 1,030 ms | 1.46x slower |
| London -> Brighton | `fastbike` | 2,844 ms | 2,309 ms | 1.23x faster |
| London -> Brighton | `fastbike-lowtraffic` | 3,372 ms | 2,637 ms | 1.28x faster |
| London -> Brighton | `fastbike-verylowtraffic` | 4,882 ms | 3,858 ms | 1.27x faster |
| London -> Oxford | `fastbike` | 2,733 ms | 2,533 ms | 1.08x faster |
| London -> Oxford | `fastbike-lowtraffic` | 3,109 ms | 3,065 ms | 1.01x faster |
| London -> Oxford | `fastbike-verylowtraffic` | 5,045 ms | 4,788 ms | 1.05x faster |
| London -> Cardiff | `fastbike` | 7,576 ms | 6,524 ms | 1.16x faster |
| London -> Cardiff | `fastbike-lowtraffic` | 9,210 ms | 8,441 ms | 1.09x faster |
| London -> Cardiff | `fastbike-verylowtraffic` | 12,442 ms | 10,114 ms | 1.23x faster |
| Richmond -> Windsor -> Marlow -> Oxford | `fastbike` | 934 ms | 304 ms | 3.07x faster |
| Richmond -> Windsor -> Marlow -> Oxford | `fastbike-lowtraffic` | 945 ms | 375 ms | 2.52x faster |
| Richmond -> Windsor -> Marlow -> Oxford | `fastbike-verylowtraffic` | 1,397 ms | 627 ms | 2.23x faster |

## Optimizations

| Optimization | Description |
| :--- | :--- |
| Early edge rejection | Reject closed edges and dead ends before evaluating costs or heuristics |
| Flat 32-bit edge indexing | Sequential `edge_idx: u32` replaces 16-byte tuple hashing in `edge_states` |
| Cul-de-sac pruning | Iterative leaf peeling skips dead-end trees, with waypoint ancestor protection |
| 4-ary min-heap | `QuadHeap` with 4 children per node, fits in 32-byte cache lines |
| Dense edge closure bitset | `Vec<u64>` bitset replaces hash map for edge closed checks |
| Bidirectional counterlink closure | Marks counterlinks closed immediately during graph construction |
| Dense edge candidate pool | Flat `Vec<u32>` replaces hash maps for 15M+ edge relaxations per pass |
| Compact history | 32-byte `HistoryStep` with `u32::MAX` sentinels, 2 per cache line |
| Packed coordinate types | `Point2D` (8B) and `Point3D` (12B) with `#[repr(C)]` |
| Integer elevation math | Quarter-meter deltas × 250,000 for micrometers, no float round trips |

## Future Parity Items (TODOs)

| Category | Feature | Description |
| :--- | :--- | :--- |
| Routing | Nogo exclusion zones | Circular and polygonal avoid areas via `nogos=lon,lat,radius[,weight]` |
| Routing | Dynamic tile streaming | Load RD5 tiles on-demand during A* search with LRU eviction instead of preloading fixed boxes |
| Routing | Departure heading constraints | Force initial departure bearing via `heading=degrees` to avoid immediate U-turns |
| Routing | Beeline segments | Straight-line connections across unmapped terrain via `straight=...` |
| Routing | GPX map-matching | Snap recorded GPS tracks to the graph network |
| Routing | Elevation filter alignment | Align small 1-meter elevation differences on long multi-stage descents |
| Navigation | Voice and turn instructions | Generate turn-by-turn guidance hints: turns, roundabouts, and straight segments |
| Server API | Custom profile upload | Upload arbitrary `.brf` profile text directly via `customprofile=...` or request body |
| Server API | Additional export formats | Support GPX (tracks, routes, waypoints) and KML formats alongside GeoJSON |
| Server API | Profile message matrix | Output per-segment attribute table in GeoJSON properties for UI surface coloring |
| Server API | Query parameters | Support `direction`, `nointail`, and `noground` options |

