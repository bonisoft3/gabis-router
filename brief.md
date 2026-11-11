# Gabi's Router

A browser-native, offline-capable bicycle route planner powered by `brouter-rs` in WebAssembly, MapLibre GL JS vector cycling maps, and Cortex state machines.

## Data

All state lives in the cyclist's browser (`durability: "device"` and `"tab"`):

- **`PlannerState` (`planner_state`)** — the active route planner configuration, waypoints, avoid areas (nogo circles), undo/redo history, custom `.brf` profile definitions, hover highlight state, and Cortex row-machine columns (`theme`, `units`, `drawer`, `modal`, `breakdown_tab`, `active_slot`, `basemap`, `terrain_3d`, `legend_open`, `clear_confirm`, `share_status`).
- **`RouteSlot` (`route_slot`)** — up to three concurrent comparison slots (`slot-0`, `slot-1`, `slot-2`), each holding its selected `.brf` profile, alternative route index (`0..2`), and color token.
- **`RouteAnswer` (`route_answer`)** — memoized answers from the `brouter` WebAssembly agent unit keyed by `request_key`, carrying computed distance, duration, ascent, descent, cost, GeoJSON polyline, elevation profile points, surface/road/traffic/noise/speed segment breakdowns, route warnings, and `.rd5` point inspection payloads.
- **`PlaceAnswer` (`place_answer`)** — memoized answers from the `geocoder` Nominatim agent unit keyed by `(kind, q, lang)` for forward place search and reverse waypoint naming.
- **`OfflineBundle` (`offline_bundle`)** — decomposed IndexedDB storage status for regional `.rd5` routing subtiles and `.pmtiles` vector map blocks.

## Screens

- **Router (`/`)** — full-bleed interactive cycling map with floating glassmorphic workbench sidebar (waypoints, geocoder search, profile comparison slots, avoid areas, undo/redo, GPX import/export, URL share), bottom analytics drawer (pure Jessie elevation SVG chart, surface/road/traffic/noise/speed stacked breakdowns, route warnings), and modals for the visual `.brf` Profile Editor, Offline Map & Routing Storage, Point Inspector, and About.

## Behavior

Every UI state transition (theme, metric/imperial units, drawer posture, active comparison slot, breakdown tab, basemap, 3D terrain, legend, modals, two-tap clear confirmation, and share feedback) is governed by Cortex `via: "rows"` statecharts (`routerRows`) verified by XState model checking. Domain mutations (waypoint editing, nogo circles, bounded undo/redo history, and `.brf` compilation) run in pure Jessie handlers. WebAssembly routing (`brouter`), Nominatim geocoding (`geocoder`), and MapLibre GL JS rendering (`router-map`) execute behind typed Omnishell unit boundaries (`data-hatch`).

![[acceptance]]

## Out of scope

Server-side user accounts, cloud route databases, or social feeds; all routing, map rendering, and offline storage run locally on the user's device.
