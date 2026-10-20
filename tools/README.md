# Tools

Utilities for offline map data, routing segments, test fixtures, and live frontend inspection.

## Frontend MCP Server (`mcp-frontend.mjs`)

Exposes the live browser app to Model Context Protocol clients and CLI scripts.

### Purpose

| Use Case | How the MCP Layer Supports It |
| :--- | :--- |
| Interactive UI Development | Lets an agent or script drive the live browser tab while editing React, CSS, or WASM code, without launching a separate headless browser. |
| Profile and Route Evaluation | Computes routes across multiple `.brf` profiles, returns surface, road-type, traffic, noise, and speed-limit breakdowns in meters, and captures side-by-side map screenshots. |
| Rubric-Based E2E Validation | Executes multi-step user journeys and verifies both structured state assertions (`routeSummary`, `map.routeSourceFeatures`, `map.domMarkerCount`, `displayedStats`) and visual layout (`ui_screenshot`). |
| Responsive and Mobile Testing | Resizes `#root` (`set_viewport`) and injects mobile media-query rules (`max-width: 860px`) to verify drawer auto-collapse, touch targets, and map controls on mobile dimensions. |
| Journey Recording | Logs every action and state transition (`ui_journey_log`) so interactive exploratory sessions can be replayed or converted into automated regression scripts. |

### Architecture

| Component | Path | Transport | Role |
| :--- | :--- | :--- | :--- |
| Stdio Server / CLI | `tools/mcp-frontend.mjs` | JSON-RPC 2.0 over `stdio` to HTTP `POST /__mcp` | Translates MCP tool calls into requests against the Vite dev server. |
| Vite Middleware | `web/vite.config.ts` (`mcp-bridge`) | HTTP `POST /__mcp` to Vite HMR WebSocket | Forwards commands (`mcp:command`) to the active browser tab, awaits `mcp:result`, and writes composite PNG screenshots to disk. |
| Browser Bridge | `web/src/mcp-bridge.ts` (`useMcpBridge`) | Vite HMR WebSocket (`import.meta.hot`) | Reads React hooks (`useRouting`, `useOffline`, `useCompare`, `useSettings`), controls the MapLibre camera, pumps WebGL frames, and composites the WebGL canvas with DOM overlays via `html-to-image`. |

### Available Tools

| Tool | Arguments | Description |
| :--- | :--- | :--- |
| `ui_get_state` | None | Returns waypoints, profile, alternative index, avoid areas, route summary metrics, compared GPX stats, UI drawer state, viewport dimensions, and MapLibre layer feature counts. |
| `ui_set_route` | `waypoints`, `profile`, `alternativeIdx`, `avoidAreas`, `fitBounds`, `waitForRoute` | Sets route inputs, waits for the WASM worker and MapLibre render queue to settle, and returns the updated state snapshot. |
| `ui_interact` | `action` plus action-specific fields | Runs a single UI action in the live browser tab and returns the updated state snapshot. |
| `ui_compare_gpx` | `filePath`, `gpxContent`, `matchStartAndEnd`, `clear` | Loads a `.gpx` file or BRouter `.json` fixture as a comparison overlay, optionally snaps start and end waypoints, or clears the active comparison. |
| `ui_map_camera` | `center`, `zoom`, `fitBounds` | Jumps the MapLibre camera to a coordinate and zoom level or fits bounds to the active route. |
| `ui_screenshot` | `outPath` | Composites the MapLibre WebGL canvas and UI overlays into a PNG file. Defaults to `web/mcp-screenshot.png`. |
| `ui_journey_log` | `clear` | Returns or clears the session log of MCP commands and state transitions. |

### `ui_interact` Actions

| Action | Parameters | Behavior |
| :--- | :--- | :--- |
| `add_waypoint` | `lat`, `lon`, `name?`, `mode?` (`start`, `end`, `via`, `append`) | Adds or geocodes a waypoint. |
| `move_waypoint` | `index`, `lat`, `lon` | Moves an existing waypoint to new coordinates. |
| `remove_waypoint` | `index` | Removes the waypoint at `index`. |
| `rename_waypoint` | `index`, `name` | Sets a custom label on the waypoint at `index`. |
| `reverse_route` | None | Reverses waypoint order and recomputes the route. |
| `clear_route` | None | Clears all waypoints and route layers. |
| `import_gpx` | `gpxContent?`, `toleranceM?` (default `20`) | Map-matches a GPX track (or the active `comparedRoute`) and extracts minimal editable waypoints within `toleranceM` meters. |
| `add_avoid_area` | `lat`, `lon`, `radius?` | Adds a circular no-go area. |
| `remove_avoid_area` | `index` | Removes the avoid area at `index`. |
| `clear_avoid_areas` | None | Removes all avoid areas. |
| `select_alternative` | `alternativeIdx` (`0..3`) | Switches between the primary route and alternatives. |
| `hover_route_distance` | `distanceMeters` (`number` or `null`) | Moves or clears the elevation profile hover marker at a distance along the route. |
| `highlight_category` | `kind` (`surface`, `road`, `clear`), `category?` | Highlights matching route segments on the map or clears the highlight. |
| `toggle_controls` | `collapsed?` | Collapses or expands the left controls panel. |
| `toggle_route_info` | `collapsed?` | Collapses or expands the bottom route info drawer. |
| `toggle_settings` | `open?` | Opens or closes the settings modal. |
| `toggle_about` | `open?` | Opens or closes the about modal. |
| `set_settings` | `units?`, `theme?`, `basemap?`, `offlineMode?` | Updates app preferences. |
| `set_viewport` | `width`, `height` (`null` to reset) | Resizes `#root` and simulates mobile/desktop media queries (`max-width: 860px`). |
| `undo` / `redo` | None | Steps backward or forward in waypoint and avoid-area history. |
| `click_selector` | `selector` | Triggers `.click()` on the matching DOM element. |

### End-to-End Testing and Validation

Each E2E user journey validates two layers at every step:
1. State and DOM rubric (`ui_get_state` / tool return payload): verifies that the WASM worker, React state, DOM text nodes, and MapLibre GeoJSON sources match expected values.
2. Visual rubric (`ui_screenshot`): verifies that the WebGL canvas (tiles, route casing, comparison overlay, avoid polygons, markers) and HTML overlays (drawers, charts, attribution, modals) render without clipping or overlap.

#### Validation Rubric Reference

| Journey Step | Tool Call | State Assertions (`result`) | Visual Check (`ui_screenshot`) |
| :--- | :--- | :--- | :--- |
| 1. Compute baseline route | `ui_set_route` | `isError === false`, `waypoints.length === 2`, `routeSummary.distanceMeters > 0`, `map.routeSourceFeatures === 1`, `map.domMarkerCount === 2` | Start (`A`) and end (`B`) markers and blue route polyline fit inside the viewport. |
| 2. Add avoid area & reroute | `ui_interact` (`add_avoid_area`) | `avoidAreas.length === 1`, `map.avoidSourceFeatures === 1`, `routeSummary.cost` changes, `canUndo === true` | Red dashed no-go polygon renders on the map and the route detours around it. |
| 3. Compare against GPX / fixture | `ui_compare_gpx` | `comparedRoute !== null`, `map.compareSourceFeatures === 1` | Dashed magenta comparison line renders alongside the active route and delta badges appear in the stats card. |
| 4. Import GPX as editable route | `ui_interact` (`import_gpx`) | `waypoints.length >= 2`, `Math.abs(routeSummary.distanceMeters - comparedRoute.distanceMeters) < 100` | Raw GPX track collapses to minimal `A`, via (`1..n`), and `B` markers following the reference route. |
| 5. Highlight surface / road category | `ui_interact` (`highlight_category`) | `ui.hasSegmentHighlight === true`, `map.highlightSourceFeatures > 0` | Matching segments glow on the map and the elevation profile dims non-matching segments. |
| 6. Undo / Redo history | `ui_interact` (`undo` / `redo`) | `waypoints` and `avoidAreas` restore prior counts; `routeSummary.distanceMeters` matches prior step | Markers and route geometry revert cleanly. |
| 7. Mobile layout verification | `ui_interact` (`set_viewport`, `390x844`) | `ui.viewport.width === 390`, `ui.viewport.simulated === true` | Top controls sheet and bottom route drawer do not overlap; attribution pill remains readable at bottom-right. |

#### Running an E2E Journey from the CLI

1. Start the Vite dev server and open `https://localhost:3000` in a browser tab:

```bash
npm --prefix web run dev
```

2. Run a multi-step validation sequence:

```bash
# Clear journey log and reset state
node tools/mcp-frontend.mjs call ui_journey_log '{"clear":true}'
node tools/mcp-frontend.mjs call ui_interact '{"action":"clear_route"}'

# Step 1: Route from Clapham to Hackney under gabis-safe-road
node tools/mcp-frontend.mjs call ui_set_route '{
  "profile": "gabis-safe-road",
  "waypoints": [
    {"lat": 51.462413, "lon": -0.143615},
    {"lat": 51.544995, "lon": -0.055296}
  ]
}'

# Step 2: Load a fastbike fixture for comparison, then import it as editable waypoints
node tools/mcp-frontend.mjs call ui_compare_gpx '{
  "filePath": "fixtures/brouter_de/clapham_hackney_fastbike.json"
}'
node tools/mcp-frontend.mjs call ui_interact '{"action": "import_gpx", "toleranceM": 20}'

# Step 3: Capture desktop and mobile screenshots for visual verification
node tools/mcp-frontend.mjs call ui_screenshot '{"outPath": "web/e2e-desktop.png"}'
node tools/mcp-frontend.mjs call ui_interact '{"action": "set_viewport", "width": 390, "height": 844}'
node tools/mcp-frontend.mjs call ui_screenshot '{"outPath": "web/e2e-mobile.png"}'
node tools/mcp-frontend.mjs call ui_interact '{"action": "set_viewport", "width": null, "height": null}'

# Step 4: Inspect the recorded journey log
node tools/mcp-frontend.mjs call ui_journey_log
```

### MCP Client Configuration

Register the MCP server in your client configuration:

```json
{
  "mcpServers": {
    "rsrouter-frontend": {
      "command": "node",
      "args": ["/absolute/path/to/rsrouter/tools/mcp-frontend.mjs"]
    }
  }
}
```

## Data and Fixture Updater (`update_data.py`)

Downloads updated BRouter `.rd5` segments and test fixtures, with options to sync test assertions.

### Usage

```bash
# Update both segments and fixtures, sync test assertions, and verify parity:
python3 tools/update_data.py --update-tests --check

# Update only RD5 segments:
python3 tools/update_data.py --rd5-only

# Update specific RD5 segments:
python3 tools/update_data.py --rd5-only --segments E0_N50 W5_N50 W10_N50

# Update only baseline fixtures from brouter.de:
python3 tools/update_data.py --fixtures-only

# Sync hardcoded test assertions to current fixture data:
python3 tools/update_data.py --tests-only
```

### Options

| Flag | Description |
| :--- | :--- |
| `--segments [NAMES ...]` | List of segments to download. Defaults to `E0_N50` and `W5_N50`. |
| `--rd5-only` | Update only `.rd5` segment files in `data/segments4/`. |
| `--fixtures-only` | Update only GeoJSON baseline fixtures in `fixtures/brouter_de/`. |
| `--update-tests` | Sync hardcoded test assertions in `rsrouter-core` tests. |
| `--tests-only` | Sync test assertions without downloading new files. |
| `--check` | Run `cargo test` and `compare_routes` after updating. |

## PMTiles CLI

Download the `pmtiles` binary for your platform from:
https://github.com/protomaps/go-pmtiles/releases

Place the executable at `tools/pmtiles` and ensure it has execute permissions:

```bash
chmod +x tools/pmtiles
```
