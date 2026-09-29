# rsrouter

BRouter alternative implemented in Rust.

## Overview

`rsrouter` is a native Rust port of the [BRouter](https://github.com/abrensch/brouter) routing engine. It decodes official BRouter `.rd5` segments, parses `.brf` profile scripts, and executes 2-pass guided A* search with elevation hysteresis and kinematic simulation.

For detailed parity benchmarks against upstream Java BRouter, see [PARITY.md](file:///Users/gsurita/Documents/rsrouter/PARITY.md).

## Key Features

- **RD5 Tile Decoding**: Direct binary reading of BRouter 5.x RD5 data tiles (`MicroCache2`, `BitCoder`).
- **Profile DSL Engine**: Parser and evaluator for BRouter `.brf` profile files and `lookups.dat`.
- **2-Pass Guided A\* Search**: Initial search pass with `pass1coefficient`, followed by cost-cutting guided search.
- **Elevation and Kinematics**: 3-buffer elevation hysteresis, cubic speed solver, air drag, rolling resistance, and power modeling.
- **BRouter Compatible API**: Standalone HTTP server accepting standard BRouter query parameters.
- **Automated Parity Suite**: Regression test suite comparing tracks against official Java BRouter outputs.

## Project Structure

| Component | Path | Description |
| :--- | :--- | :--- |
| Core Library | [`src/lib.rs`](file:///Users/gsurita/Documents/rsrouter/src/lib.rs) | Top-level module declarations |
| RD5 Decoder | [`src/rd5/`](file:///Users/gsurita/Documents/rsrouter/src/rd5) | Tile manager, byte stream decoders, variable bit codecs |
| Graph Topology | [`src/graph/`](file:///Users/gsurita/Documents/rsrouter/src/graph) | Spatial graph, nodes, links, and waypoint snapping |
| Profile DSL | [`src/dsl/`](file:///Users/gsurita/Documents/rsrouter/src/dsl) | Profile parser, expression evaluator, lookup tables |
| Search Engine | [`src/routing/`](file:///Users/gsurita/Documents/rsrouter/src/routing) | Guided A*, elevation hysteresis, kinematic physics |
| HTTP Server | [`src/server/`](file:///Users/gsurita/Documents/rsrouter/src/server) | Axum web service exposing `/brouter` endpoint |
| Comparison Binary | [`src/bin/compare_routes.rs`](file:///Users/gsurita/Documents/rsrouter/src/bin/compare_routes.rs) | Corridor benchmark and parity regression gate |
| Visualizer Binary | [`src/bin/plot_routes.rs`](file:///Users/gsurita/Documents/rsrouter/src/bin/plot_routes.rs) | Leaflet HTML visualizer for route inspection |

Takeaway: Modules separate low-level binary decoding, graph storage, profile evaluation, and search execution.

## Quick Start

### Build and Test

Run all unit and integration tests:

```bash
cargo test
```

### Run Parity Comparison Suite

Evaluate all 12 focus routes against upstream BRouter fixtures:

```bash
cargo run --release --bin compare_routes
```

### Generate Route Visualizations

Generate the interactive Leaflet HTML route comparison map:

```bash
cargo run --release --bin plot_routes
```

The output file is written to `routes_comparison.html`.

### Run the HTTP API Server

Start the local BRouter API server with on-demand tile loading:

```bash
cargo run --release --bin server
```

Or preload a regional bounding box at startup for zero-latency graph access:

```bash
cargo run --release --bin server -- --preload-bbox "-3.18,50.82,-0.05,51.75"
```

Test a routing query:

```bash
curl "http://localhost:17777/brouter?lonlats=-0.143613,51.462414|-0.055296,51.544998&profile=fastbike&format=geojson"
```

## Graph Architecture

The engine supports two loading modes:

| Mode | Memory Footprint | Query Graph Load Time | Use Case |
| :--- | :--- | :--- | :--- |
| **Preloaded Regional BBox** | ~550 MB static | **0 ms** | Production servers, high-concurrency instances |
| **On-Demand Bounding Box** | 150 to 450 MB dynamic | 2.8 s to 4.5 s | Memory-constrained systems, one-off single trips |

The benchmark suite (`compare_routes`) loads each corridor's bounding box into memory once, evaluating all routing profiles for that corridor with zero additional disk access.

## Benchmarks and Type Safety

Split coordinate primitives are grouped into zero-cost geometric structures (`Point2D` and `Point3D` with `#[repr(C)]`). Memory layout is identical to raw primitives: 8 bytes for 2D points and 12 bytes for 3D points.

### Benchmark Comparison Against Baseline

Latency comparison before and after grouping coordinates into `Point2D` and `Point3D`:

| Corridor | Profile | Baseline Latency | Grouped Types Latency | Difference |
| :--- | :--- | :--- | :--- | :--- |
| Clapham -> Hackney | `fastbike` | 1,112 ms | 1,252 ms | +140 ms |
| Clapham -> Hackney | `fastbike-lowtraffic` | 1,169 ms | 1,315 ms | +146 ms |
| Clapham -> Hackney | `fastbike-verylowtraffic` | 1,204 ms | 1,350 ms | +146 ms |
| London -> Brighton | `fastbike` | 2,259 ms | 2,353 ms | +94 ms |
| London -> Brighton | `fastbike-lowtraffic` | 2,684 ms | 2,892 ms | +208 ms |
| London -> Brighton | `fastbike-verylowtraffic` | 4,188 ms | 4,017 ms | -171 ms |
| London -> Oxford | `fastbike` | 2,614 ms | 2,347 ms | -267 ms |
| London -> Oxford | `fastbike-lowtraffic` | 3,023 ms | 2,770 ms | -253 ms |
| London -> Oxford | `fastbike-verylowtraffic` | 4,696 ms | 4,353 ms | -343 ms |
| London -> Cardiff | `fastbike` | 6,286 ms | 6,094 ms | -192 ms |
| London -> Cardiff | `fastbike-lowtraffic` | 7,586 ms | 7,387 ms | -199 ms |
| London -> Cardiff | `fastbike-verylowtraffic` | 8,918 ms | 8,676 ms | -242 ms |
| Regional Graph Load | - | 5,696 ms | 5,573 ms | -123 ms |

Parity status: 12 / 12 routes meet parity bounds with 0 regressions.


