# rsrouter

BRouter alternative implemented in Rust.

Reads BRouter `.rd5` tiles and `.brf` profiles, runs 2-pass A* search with elevation and kinematic modeling, and serves routes over HTTP. See [PARITY.md](PARITY.md) for benchmarks against upstream Java BRouter.

## Project Structure

| Crate | Path | Description |
| :--- | :--- | :--- |
| `rsrouter-core` | `crates/rsrouter-core/` | Core library: RD5 decoding, graph topology, profile DSL, and guided A* routing |
| `rsrouter-server` | `crates/rsrouter-server/` | HTTP service (`/brouter`), parity benchmarks (`compare_routes`), and visualizer (`plot_routes`) |

## Quick Start

### Build and Test

```bash
cargo test
```

### Run Parity Comparison Suite

Evaluate all 15 focus routes against upstream BRouter fixtures:

```bash
cargo run --release -p rsrouter-server --bin compare_routes
```

### Generate Route Visualizations

```bash
cargo run --release -p rsrouter-server --bin plot_routes
```

The output is written to `routes_comparison.html`.

### Run the HTTP API Server

Start the server with on-demand tile loading:

```bash
cargo run --release -p rsrouter-server --bin server
```

Or preload a regional bounding box at startup:

```bash
cargo run --release -p rsrouter-server --bin server -- --preload-bbox "-3.18,50.82,-0.05,51.75"
```

Test a routing query:

```bash
curl "http://localhost:17777/brouter?lonlats=-0.143613,51.462414|-0.055296,51.544998&profile=fastbike&format=geojson"
```

## Graph Loading Modes

| Mode | Memory | Graph Load Time | Use Case |
| :--- | :--- | :--- | :--- |
| Preloaded Regional BBox | ~550 MB | 0 ms | Production, high concurrency |
| On-Demand Bounding Box | 150 to 450 MB | 2.8 to 4.5 s | Low memory, one-off queries |

## Performance and Parity

12 of 15 routes match upstream BRouter point for point. The remaining 3 diverge by at most 521 m due to tie-breaking on equal-cost alternatives. All routes stay within 0.21% distance delta and 0.18% cost delta.

On medium and long corridors, `rsrouter` is 1.05x to 3.07x faster than the official BRouter server. Short routes on the regional graph are 1.3x to 1.5x slower.

See [PARITY.md](PARITY.md) for full tables and analysis.

## Pre-Launch Checklist

Items to revisit before public release or commercial deployment:

| Area | Current State | Production Requirement |
| :--- | :--- | :--- |
| Basemap API Keys | Thunderforest key hardcoded in client bundle | Use a backend tile proxy or require user-supplied keys to avoid quota depletion |
| Tile Usage Limits | Free tier on Thunderforest: 150,000 tiles per month, public CyclOSM | Verify commercial license and tile caching compliance under production traffic |
| Tile and Routing Data CDN | Local files and test mirrors | Set up a production CDN with cache-control headers for `.rd5` and `.pmtiles` archives |
| Error and Usage Telemetry | Local console error filtering only | Establish privacy-respecting error tracking with user opt-in |

