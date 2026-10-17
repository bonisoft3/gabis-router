# rsrouter

BRouter alternative implemented in Rust.

Reads BRouter `.rd5` tiles and `.brf` profiles, runs 2-pass A* search with elevation and kinematic modeling, and serves routes over HTTP. See [PARITY.md](PARITY.md) for benchmarks against upstream Java BRouter.

## Project Structure

| Component | Path | Description |
| :--- | :--- | :--- |
| `rsrouter-core` | `crates/rsrouter-core/` | Core library: RD5 decoding, graph topology, profile DSL, guided A* routing, and GPX map matching |
| `rsrouter-wasm` | `crates/rsrouter-wasm/` | WebAssembly bindings for browser routing and GPX waypoint extraction |
| `rsrouter-server` | `crates/rsrouter-server/` | HTTP service (`/brouter`), parity benchmarks (`compare_routes`), and visualizer (`plot_routes`) |
| `web` | `web/` | React + MapLibre PWA frontend. See [web/README.md](web/README.md) |
| `tools` | `tools/` | Data updater, PMTiles extractor, and Frontend MCP server (`mcp-frontend.mjs`). See [tools/README.md](tools/README.md) |

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

### Update Data and Fixtures

Download the latest upstream `.rd5` segments and refresh parity test fixtures:

```bash
python3 tools/update_data.py --update-tests --check
```

See [tools/README.md](tools/README.md) for individual component flags.

## Graph Loading Modes

| Mode | Memory | Graph Load Time | Use Case |
| :--- | :--- | :--- | :--- |
| Preloaded Regional BBox | ~550 MB | 0 ms | Production, high concurrency |
| On-Demand Bounding Box | 150 to 450 MB | 2.8 to 4.5 s | Low memory, one-off queries |

## Performance and Parity

15 of 15 primary routes and 2 of 3 alternative routes match upstream BRouter point for point, with 0.00% distance delta, 0.00% cost delta, 0.00% to 0.02% time delta, and identical filtered ascend. Alternative 3 matches total cost (`165368`) and ascend (`859 m`) with 98.6% coordinate overlap.

See [PARITY.md](PARITY.md) for full tables and analysis.

## Pre-Launch Checklist

Items to revisit before public release or commercial deployment:

| Area | Current State | Production Requirement |
| :--- | :--- | :--- |
| Basemap API Keys | Thunderforest key hardcoded in client bundle | Use a backend tile proxy or require user-supplied keys to avoid quota depletion |
| Tile Usage Limits | Free tier on Thunderforest: 150,000 tiles per month, public CyclOSM | Verify commercial license and tile caching compliance under production traffic |
| Tile and Routing Data CDN | Local files and test mirrors | Set up a production CDN with cache-control headers for `.rd5` and `.pmtiles` archives |
| Error and Usage Telemetry | Local console error filtering only | Establish privacy-respecting error tracking with user opt-in |

