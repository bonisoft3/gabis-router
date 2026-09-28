# rsrouter

BRouter alternative implemented in Rust.

## Overview

`rsrouter` is a native Rust port of the [BRouter](https://github.com/abrensch/brouter) routing engine. It decodes official BRouter `.rd5` segments, parses `.brf` profile scripts, and executes 2-pass guided A* search with elevation hysteresis and kinematic simulation.

For detailed parity benchmarks against upstream Java BRouter, see [PARITY.md](file:///Users/gsurita/Documents/rsrouter/PARITY.md).

## Key Features

- **RD5 Tile Decoding**: Memory mapped reading of BRouter 5.x data tiles (`MicroCache2`, `BitCoder`).
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

Start the local BRouter API server:

```bash
cargo run --release --bin server
```

Test a routing query:

```bash
curl "http://localhost:17777/brouter?lonlats=-0.143613,51.462414|-0.055296,51.544998&profile=fastbike&format=geojson"
```

