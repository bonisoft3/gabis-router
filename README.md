# rsrouter

Bicycle route planner and offline-capable web application powered by [`brouter-rs`](subrepos/brouter-rs).

## Project Structure

| Component | Path | Description |
| :--- | :--- | :--- |
| `brouter-rs` | `subrepos/brouter-rs/` | Core BRouter engine in Rust (RD5 decoding, profile DSL, 2-pass guided A* search, HTTP server demo, and parity benchmarks). See [subrepos/brouter-rs/README.md](subrepos/brouter-rs/README.md) |
| `route-tools` | `crates/route-tools/` | Product routing utilities: GPX / GPS track map-matching, minimal waypoint extraction, and surface/road segment breakdowns |
| `rsrouter-wasm` | `crates/rsrouter-wasm/` | WebAssembly bindings for browser routing and GPX waypoint extraction |
| `profiles` | `profiles/` | Custom product `.brf` profiles (`gabis-*`) and standard BRouter profiles |
| `web` | `web/` | Omnishell + MapLibre PWA frontend. See [web/README.md](web/README.md) |
| `tools` | `tools/` | Data updater, PMTiles extractor, and Frontend MCP server (`mcp-frontend.mjs`). See [tools/README.md](tools/README.md) |

## Quick Start

### Build and Test

Run product tests (`route-tools` and `rsrouter-wasm`):

```bash
cargo test
```

Run `brouter-rs` core and parity tests:

```bash
cargo test --manifest-path subrepos/brouter-rs/Cargo.toml
```

### Build WebAssembly Bindings and Run Frontend

```bash
npm --prefix web run build:wasm
npm --prefix web run dev
```

### Run BRouter Server Demo and Parity Tools

```bash
# Run drop-in BRouter HTTP server on port 17777
cargo run --release --manifest-path subrepos/brouter-rs/Cargo.toml --example server

# Run parity benchmark suite
cargo run --release --manifest-path subrepos/brouter-rs/Cargo.toml --example compare_routes

# Generate interactive route comparison map (routes_comparison.html)
cargo run --release --manifest-path subrepos/brouter-rs/Cargo.toml --example plot_routes
```

### Update Data and Fixtures

Download the latest official BRouter `.rd5` segments and refresh parity test fixtures:

```bash
python3 tools/update_data.py --update-tests --check
```

## Pre-Launch Checklist

Items to revisit before public release or commercial deployment:

| Area | Current State | Production Requirement |
| :--- | :--- | :--- |
| Basemap API Keys | Thunderforest key read from `VITE_THUNDERFOREST_KEY` at build time | Restrict allowed HTTP Referer in Thunderforest dashboard or supply user key |
| Tile Usage Limits | Free tier on Thunderforest: 150,000 tiles per month, public CyclOSM | Verify commercial license and tile caching compliance under production traffic |
| Tile and Routing Data CDN | Local files and test mirrors | Set up a production CDN with cache-control headers for `.rd5` and `.pmtiles` archives |
| Error and Usage Telemetry | Local console error filtering only | Establish privacy-respecting error tracking with user opt-in |
