# Acceptance

- [ ] Clicking two or more points on the map or entering coordinates computes a bicycle route via the `brouter` WebAssembly engine, rendering the polyline on the map and displaying distance, duration, ascent, descent, and cost in the summary bar. {#accept-route}
- [ ] Searching for a place via Nominatim geocoding or editing a waypoint inline adds, reorders, reverses, undoes/redoes, or clears waypoints while keeping the route synchronized. {#accept-waypoints}
- [ ] Up to three routing slots (Slots 1–3) compare distinct cycling profiles (`gabis-safe-road`, `gabis-fast-city`, `gabis-lite-gravel`, `fastbike-lowtraffic`, `fastbike`, `gravel`, `trekking`, `mtb`, `shortest`) and alternative routes (`Alt 1..3`) simultaneously. {#accept-compare}
- [ ] The bottom analytics drawer renders a pure Jessie slope-colored SVG elevation profile with hover scrubbing and stacked breakdown bars for Surface, Road Type, Traffic, Noise, Speed Limit, and Route Warnings. {#accept-analytics}
- [ ] The visual Profile Editor compiles custom cycling preferences (Traffic, Surface, Hills, Speed, Scenery, Junction penalties, or raw `.brf` DSL) into a live `.brf` profile and re-routes the active slot. {#accept-profile-editor}
- [ ] Avoid areas (nogo circles) can be added, resized (`250m`–`5km`), and cleared to route around hazards, and routes can be imported (with Wasm GPX map-matching), exported as `.gpx`, or shared via URL hash. {#accept-avoid-gpx}
- [ ] Decomposed `.rd5` routing tiles and `.pmtiles` vector basemap bundles can be managed for offline routing and map rendering, and right-clicking a road inspects its `.rd5` tags (`inspect_point`) with a direct OpenStreetMap link. {#accept-offline}
- [ ] Cortex row statecharts (`routerRows`) drive theme (`auto`/`light`/`dark`), unit system (`metric`/`imperial`), drawer state (`open`/`collapsed`), basemap style, 3D terrain, map legend, modals, and timed confirmations (`clear_confirm`, `share_status`). {#accept-cortex-ui}
