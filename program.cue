// Gabi's Router: bicycle route planner in Pronto + Cortex.
@extern(embed)

package gabis_router

import (
	pronto "github.com/bonisoft3/pronto"
)

_designMd:   _ @embed(file="DESIGN.md", type=text)
_catalogues: _ @embed(glob="messages/*.json")

_defaultBrf: "# Custom BRouter profile\n---context:global\nassign processUnusedTags = true\n---context:way\nassign costfactor = 1.0"
_defaultWaypoints: "[[-0.1276,51.5072,\"Trafalgar Square, London\"],[-0.0754,51.5055,\"Tower Bridge, London\"]]"
_defaultRequestKey: "{\"w\":[[-0.1276,51.5072,\"Trafalgar Square, London\"],[-0.0754,51.5055,\"Tower Bridge, London\"]],\"a\":[],\"p\":[\"gabis-fast-city\",\"gabis-safe-road\",\"gabis-lite-gravel\"],\"alt\":[0,0,0],\"active\":0,\"brf\":\"# Custom BRouter profile\\n---context:global\\nassign processUnusedTags = true\\n---context:way\\nassign costfactor = 1.0\"}"
_defaultElevationJson: "{\"points\":[[0,6,0],[1.2,11,0.5],[2.4,15,0.4],[3.6,12,-0.3],[4.7,2,-0.8]],\"ascent_m\":6,\"descent_m\":10,\"distance_m\":4661,\"units\":\"metric\"}"
_defaultBreakdownJson: "{\"breakdown\":{\"surface\":[{\"label\":\"Paved Smooth\",\"distance_m\":4428,\"pct\":95},{\"label\":\"Paved Rough\",\"distance_m\":233,\"pct\":5}],\"road\":[{\"label\":\"Protected Cycleway\",\"distance_m\":3120,\"pct\":67},{\"label\":\"Cycle Lane / Shared\",\"distance_m\":840,\"pct\":18},{\"label\":\"Local Street\",\"distance_m\":701,\"pct\":15}],\"traffic\":[{\"label\":\"Quiet / Traffic-Free\",\"distance_m\":3120,\"pct\":67},{\"label\":\"Low Traffic\",\"distance_m\":1165,\"pct\":25},{\"label\":\"Moderate Traffic\",\"distance_m\":376,\"pct\":8}],\"noise\":[{\"label\":\"Quiet\",\"distance_m\":3496,\"pct\":75},{\"label\":\"Moderate\",\"distance_m\":1165,\"pct\":25}],\"speed\":[{\"label\":\"Off-road / Cycleway\",\"distance_m\":3120,\"pct\":67},{\"label\":\"≤ 30 km/h\",\"distance_m\":1541,\"pct\":33}],\"warnings\":[]},\"units\":\"metric\"}"

code: pronto.#App & {
	state: {
		entities: {
			Device: {
				id:         "0x8b1100a1b2c3d4e5"
				table:      "device"
				durability: "device"
				seed:       []
				fields: [
					{ordinal: 1, name: "id", type: "string", pk: true, cel: "this == 'device'"},
					{ordinal: 2, name: "theme", type: "string", default: "'auto'", cel: "this in ['auto', 'light', 'dark']"},
					{ordinal: 3, name: "units", type: "string", default: "'metric'", cel: "this in ['metric', 'imperial']"},
				]
			}
			PlannerState: {
				id:         "0x8b1100a1b2c3d4e6"
				table:      "planner_state"
				durability: "tab"
				seed: [{
					id:                    "planner"
					drawer:                "open"
					modal:                 "none"
					breakdown_tab:         "surface"
					basemap:               "gbrouter"
					terrain_3d:            "off"
					legend_open:           "closed"
					clear_confirm:         "idle"
					share_status:          "idle"
					search_step:           "idle"
					search_text:           ""
					search_q:              ""
					waypoints_json:        _defaultWaypoints
					waypoint_count:        2
					avoids_json:           "[]"
					avoid_count:           0
					avoid_radius_m:        500
					active_slot:           0
					active_profile:        "gabis-fast-city"
					custom_brf:            _defaultBrf
					request_key:           _defaultRequestKey
					routes_geojson:        "{\"type\":\"FeatureCollection\",\"features\":[]}"
					active_gpx:            ""
					gpx_import_xml:        ""
					hover_permille:        -1
					hover_lon:             "0.0"
					hover_lat:             "0.0"
					inspect_lon:           "0.0"
					inspect_lat:           "0.0"
					inspect_summary:       "Right-click map -> Inspect road segment to view OSM tags and cost factors."
					center_lat:            "51.5082"
					center_lon:            "-0.095"
					zoom:                  "13.0"
					start_label:           "Trafalgar Square, London"
					end_label:             "Tower Bridge, London"
					active_distance_label: "4.7 km"
					active_ascent_label:   "6 m"
					active_descent_label:  "10 m"
					active_duration_label: "13m"
					active_energy_label:   "19 kcal"
					active_warnings_count: 0
					active_elevation_json: _defaultElevationJson
					active_breakdown_json: _defaultBreakdownJson
					offline_seq:           0
				}]
				fields: [
					{ordinal: 1, name: "id", type: "string", pk: true, cel: "this == 'planner'"},
					{ordinal: 2, name: "drawer", type: "string", cel: "this in ['open', 'collapsed']"},
					{ordinal: 3, name: "modal", type: "string", cel: "this in ['none', 'custom', 'offline', 'about']"},
					{ordinal: 4, name: "breakdown_tab", type: "string", cel: "this in ['surface', 'road', 'traffic', 'noise', 'speed', 'warnings']"},
					{ordinal: 5, name: "basemap", type: "string", cel: "this in ['gbrouter', 'light', 'osm', 'cyclosm']"},
					{ordinal: 6, name: "terrain_3d", type: "string", cel: "this in ['off', 'on']"},
					{ordinal: 7, name: "legend_open", type: "string", cel: "this in ['closed', 'open']"},
					{ordinal: 8, name: "clear_confirm", type: "string", cel: "this in ['idle', 'armed']"},
					{ordinal: 9, name: "share_status", type: "string", cel: "this in ['idle', 'copied']"},
					{ordinal: 10, name: "search_step", type: "string", cel: "this in ['idle', 'open']"},
					{ordinal: 11, name: "search_text", type: "string", cel: "this.size() <= 240"},
					{ordinal: 12, name: "search_q", type: "string", cel: "this.size() <= 240"},
					{ordinal: 13, name: "waypoints_json", type: "string", cel: "this.size() <= 16384"},
					{ordinal: 14, name: "waypoint_count", type: "int32", cel: "this >= 0 && this <= 64"},
					{ordinal: 15, name: "avoids_json", type: "string", cel: "this.size() <= 8192"},
					{ordinal: 16, name: "avoid_count", type: "int32", cel: "this >= 0 && this <= 32"},
					{ordinal: 17, name: "avoid_radius_m", type: "int32", cel: "this in [250, 500, 1000, 2500, 5000]"},
					{ordinal: 18, name: "active_slot", type: "int32", cel: "this in [0, 1, 2]"},
					{ordinal: 19, name: "active_profile", type: "string", cel: "this in ['gabis-fast-city', 'gabis-safe-road', 'gabis-lite-gravel', 'fastbike-lowtraffic', 'fastbike-verylowtraffic', 'fastbike', 'gravel', 'trekking', 'mtb', 'shortest', 'custom']"},
					{ordinal: 20, name: "custom_brf", type: "string", cel: "this.size() <= 32768"},
					{ordinal: 21, name: "request_key", type: "string", cel: "this.size() <= 65536"},
					{ordinal: 22, name: "routes_geojson", type: "string", cel: "this.size() <= 131072"},
					{ordinal: 23, name: "active_gpx", type: "string", cel: "this.size() <= 131072"},
					{ordinal: 24, name: "gpx_import_xml", type: "string", cel: "this.size() <= 131072"},
					{ordinal: 25, name: "hover_permille", type: "int32", cel: "this >= -1 && this <= 1000"},
					{ordinal: 26, name: "hover_lon", type: "string", cel: "this.size() <= 32"},
					{ordinal: 27, name: "hover_lat", type: "string", cel: "this.size() <= 32"},
					{ordinal: 28, name: "inspect_lon", type: "string", cel: "this.size() <= 32"},
					{ordinal: 29, name: "inspect_lat", type: "string", cel: "this.size() <= 32"},
					{ordinal: 30, name: "inspect_summary", type: "string", cel: "this.size() <= 4096"},
					{ordinal: 31, name: "center_lat", type: "string", cel: "this.size() <= 32"},
					{ordinal: 32, name: "center_lon", type: "string", cel: "this.size() <= 32"},
					{ordinal: 33, name: "zoom", type: "string", cel: "this.size() <= 32"},
					{ordinal: 34, name: "start_label", type: "string", cel: "this.size() <= 240"},
					{ordinal: 35, name: "end_label", type: "string", cel: "this.size() <= 240"},
					{ordinal: 36, name: "active_distance_label", type: "string", cel: "this.size() <= 64"},
					{ordinal: 37, name: "active_ascent_label", type: "string", cel: "this.size() <= 64"},
					{ordinal: 38, name: "active_descent_label", type: "string", cel: "this.size() <= 64"},
					{ordinal: 39, name: "active_duration_label", type: "string", cel: "this.size() <= 64"},
					{ordinal: 40, name: "active_energy_label", type: "string", cel: "this.size() <= 64"},
					{ordinal: 41, name: "active_warnings_count", type: "int32", cel: "this >= 0 && this <= 200"},
					{ordinal: 42, name: "active_elevation_json", type: "string", cel: "this.size() <= 65536"},
					{ordinal: 43, name: "active_breakdown_json", type: "string", cel: "this.size() <= 65536"},
					{ordinal: 44, name: "offline_seq", type: "int32", cel: "this >= 0"},
				]
			}
			RouteSlot: {
				id:         "0x8b1100a1b2c3d4e7"
				table:      "route_slot"
				durability: "tab"
				seed: [
					{
						id:             "slot-0"
						slot_index:     0
						active:         "yes"
						profile:        "gabis-fast-city"
						profile_label:  "profile_gabis_fast_city"
						alt:            0
						alt_label:      "Alt 1"
						status:         "ready"
						distance_m:     4661
						distance_label: "4.7 km"
						ascent_m:       6
						ascent_label:   "6 m"
						descent_m:      10
						descent_label:  "10 m"
						time_s:         806
						duration_label: "13m"
						energy_kcal:    19
						warnings_count: 0
						elevation_json: "[[0,6,0],[1.2,11,0.5],[2.4,15,0.4],[3.6,12,-0.3],[4.7,2,-0.8]]"
						breakdown_json: "{\"surface\":[{\"label\":\"Paved Smooth\",\"distance_m\":4428,\"pct\":95},{\"label\":\"Paved Rough\",\"distance_m\":233,\"pct\":5}],\"road\":[{\"label\":\"Protected Cycleway\",\"distance_m\":3120,\"pct\":67},{\"label\":\"Cycle Lane / Shared\",\"distance_m\":840,\"pct\":18},{\"label\":\"Local Street\",\"distance_m\":701,\"pct\":15}],\"traffic\":[{\"label\":\"Quiet / Traffic-Free\",\"distance_m\":3120,\"pct\":67},{\"label\":\"Low Traffic\",\"distance_m\":1165,\"pct\":25},{\"label\":\"Moderate Traffic\",\"distance_m\":376,\"pct\":8}],\"noise\":[{\"label\":\"Quiet\",\"distance_m\":3496,\"pct\":75},{\"label\":\"Moderate\",\"distance_m\":1165,\"pct\":25}],\"speed\":[{\"label\":\"Off-road / Cycleway\",\"distance_m\":3120,\"pct\":67},{\"label\":\"≤ 30 km/h\",\"distance_m\":1541,\"pct\":33}],\"warnings\":[]}"
					},
					{
						id:             "slot-1"
						slot_index:     1
						active:         "no"
						profile:        "gabis-safe-road"
						profile_label:  "profile_gabis_safe_road"
						alt:            0
						alt_label:      "Alt 1"
						status:         "ready"
						distance_m:     5282
						distance_label: "5.3 km"
						ascent_m:       1
						ascent_label:   "1 m"
						descent_m:      5
						descent_label:  "5 m"
						time_s:         900
						duration_label: "15m"
						energy_kcal:    22
						warnings_count: 0
						elevation_json: "[[0,6,0],[1.3,8,0.2],[2.6,9,0.1],[3.9,5,-0.3],[5.3,2,-0.3]]"
						breakdown_json: "{\"surface\":[{\"label\":\"Paved Smooth\",\"distance_m\":5018,\"pct\":95},{\"label\":\"Paved Rough\",\"distance_m\":264,\"pct\":5}],\"road\":[{\"label\":\"Protected Cycleway\",\"distance_m\":3697,\"pct\":70},{\"label\":\"Local Street\",\"distance_m\":1585,\"pct\":30}],\"traffic\":[{\"label\":\"Quiet / Traffic-Free\",\"distance_m\":3697,\"pct\":70},{\"label\":\"Low Traffic\",\"distance_m\":1585,\"pct\":30}],\"noise\":[{\"label\":\"Quiet\",\"distance_m\":4226,\"pct\":80},{\"label\":\"Moderate\",\"distance_m\":1056,\"pct\":20}],\"speed\":[{\"label\":\"Off-road / Cycleway\",\"distance_m\":3697,\"pct\":70},{\"label\":\"≤ 30 km/h\",\"distance_m\":1585,\"pct\":30}],\"warnings\":[]}"
					},
					{
						id:             "slot-2"
						slot_index:     2
						active:         "no"
						profile:        "gabis-lite-gravel"
						profile_label:  "profile_gabis_lite_gravel"
						alt:            0
						alt_label:      "Alt 1"
						status:         "ready"
						distance_m:     5282
						distance_label: "5.3 km"
						ascent_m:       1
						ascent_label:   "1 m"
						descent_m:      5
						descent_label:  "5 m"
						time_s:         900
						duration_label: "15m"
						energy_kcal:    22
						warnings_count: 0
						elevation_json: "[[0,6,0],[1.3,8,0.2],[2.6,9,0.1],[3.9,5,-0.3],[5.3,2,-0.3]]"
						breakdown_json: "{\"surface\":[{\"label\":\"Paved Smooth\",\"distance_m\":5018,\"pct\":95},{\"label\":\"Paved Rough\",\"distance_m\":264,\"pct\":5}],\"road\":[{\"label\":\"Protected Cycleway\",\"distance_m\":3697,\"pct\":70},{\"label\":\"Local Street\",\"distance_m\":1585,\"pct\":30}],\"traffic\":[{\"label\":\"Quiet / Traffic-Free\",\"distance_m\":3697,\"pct\":70},{\"label\":\"Low Traffic\",\"distance_m\":1585,\"pct\":30}],\"noise\":[{\"label\":\"Quiet\",\"distance_m\":4226,\"pct\":80},{\"label\":\"Moderate\",\"distance_m\":1056,\"pct\":20}],\"speed\":[{\"label\":\"Off-road / Cycleway\",\"distance_m\":3697,\"pct\":70},{\"label\":\"≤ 30 km/h\",\"distance_m\":1585,\"pct\":30}],\"warnings\":[]}"
					},
				]
				fields: [
					{ordinal: 1, name: "id", type: "string", pk: true, cel: "this in ['slot-0', 'slot-1', 'slot-2']"},
					{ordinal: 2, name: "slot_index", type: "int32", cel: "this in [0, 1, 2]"},
					{ordinal: 3, name: "active", type: "string", cel: "this in ['yes', 'no']"},
					{ordinal: 4, name: "profile", type: "string", cel: "this in ['gabis-fast-city', 'gabis-safe-road', 'gabis-lite-gravel', 'fastbike-lowtraffic', 'fastbike-verylowtraffic', 'fastbike', 'gravel', 'trekking', 'mtb', 'shortest', 'custom']"},
					{ordinal: 5, name: "profile_label", type: "string", cel: "this.size() <= 64"},
					{ordinal: 6, name: "alt", type: "int32", cel: "this in [0, 1, 2]"},
					{ordinal: 7, name: "alt_label", type: "string", cel: "this.size() <= 32"},
					{ordinal: 8, name: "status", type: "string", cel: "this in ['ready', 'empty']"},
					{ordinal: 9, name: "distance_m", type: "int32", cel: "this >= 0"},
					{ordinal: 10, name: "distance_label", type: "string", cel: "this.size() <= 64"},
					{ordinal: 11, name: "ascent_m", type: "int32", cel: "this >= 0"},
					{ordinal: 12, name: "ascent_label", type: "string", cel: "this.size() <= 64"},
					{ordinal: 13, name: "descent_m", type: "int32", cel: "this >= 0"},
					{ordinal: 14, name: "descent_label", type: "string", cel: "this.size() <= 64"},
					{ordinal: 15, name: "time_s", type: "int32", cel: "this >= 0"},
					{ordinal: 16, name: "duration_label", type: "string", cel: "this.size() <= 64"},
					{ordinal: 17, name: "energy_kcal", type: "int32", cel: "this >= 0"},
					{ordinal: 18, name: "warnings_count", type: "int32", cel: "this >= 0"},
					{ordinal: 19, name: "elevation_json", type: "string", cel: "this.size() <= 65536"},
					{ordinal: 20, name: "breakdown_json", type: "string", cel: "this.size() <= 65536"},
				]
			}
			RouteAnswer: {
				id:         "0x8b1100a1b2c3d4e8"
				table:      "route_answer"
				durability: "tab"
				uniques: [{name: "uq_route_answer_key", cols: ["request_key"]}]
				fields: [
					{ordinal: 1, name: "id", type: "string", pk: true},
					{ordinal: 2, name: "request_key", type: "string", cel: "this.size() <= 65536"},
					{ordinal: 3, name: "slot_0_json", type: "string", cel: "this.size() <= 131072"},
					{ordinal: 4, name: "slot_1_json", type: "string", cel: "this.size() <= 131072"},
					{ordinal: 5, name: "slot_2_json", type: "string", cel: "this.size() <= 131072"},
					{ordinal: 6, name: "routes_geojson", type: "string", cel: "this.size() <= 131072"},
					{ordinal: 7, name: "active_gpx", type: "string", cel: "this.size() <= 131072"},
					{ordinal: 8, name: "inspect_json", type: "string", cel: "this.size() <= 16384"},
					{ordinal: 9, name: "matched_waypoints_json", type: "string", cel: "this.size() <= 16384"},
					{ordinal: 10, name: "offline_json", type: "string", cel: "this.size() <= 16384"},
				]
			}
			PlaceAnswer: {
				id:         "0x8b1100a1b2c3d4e9"
				table:      "place_answer"
				durability: "tab"
				uniques: [{name: "uq_place_answer_question", cols: ["kind", "q", "lang"]}]
				fields: [
					{ordinal: 1, name: "id", type: "string", pk: true},
					{ordinal: 2, name: "kind", type: "string", cel: "this in ['search', 'address', 'reverse']"},
					{ordinal: 3, name: "q", type: "string", cel: "this.size() <= 2000"},
					{ordinal: 4, name: "lang", type: "string", cel: "this.size() <= 8"},
					{ordinal: 5, name: "p0", type: "string", cel: "this.size() <= 2000"},
					{ordinal: 6, name: "p1", type: "string", cel: "this.size() <= 2000"},
					{ordinal: 7, name: "p2", type: "string", cel: "this.size() <= 2000"},
					{ordinal: 8, name: "p3", type: "string", cel: "this.size() <= 2000"},
					{ordinal: 9, name: "p4", type: "string", cel: "this.size() <= 2000"},
				]
			}
			PlaceSuggestion: {
				id:         "0x8b1100a1b2c3d4ea"
				table:      "place_suggestion"
				durability: "tab"
				fields: [
					{ordinal: 1, name: "id", type: "string", pk: true, cel: "this in ['s0', 's1', 's2', 's3', 's4']"},
					{ordinal: 2, name: "q", type: "string", cel: "this.size() <= 2000"},
					{ordinal: 3, name: "label", type: "string", cel: "this.size() <= 500"},
					{ordinal: 4, name: "line1", type: "string", cel: "this.size() <= 240"},
					{ordinal: 5, name: "district", type: "string", cel: "this.size() <= 120"},
					{ordinal: 6, name: "city", type: "string", cel: "this.size() <= 120"},
					{ordinal: 7, name: "region", type: "string", cel: "this.size() <= 120"},
					{ordinal: 8, name: "postal_code", type: "string", cel: "this.size() <= 40"},
					{ordinal: 9, name: "country", type: "string", cel: "this.size() <= 8"},
					{ordinal: 10, name: "latitude", type: "string", cel: "this.size() <= 32"},
					{ordinal: 11, name: "longitude", type: "string", cel: "this.size() <= 32"},
				]
			}
			OfflineBundle: {
				id:         "0x8b1100a1b2c3d4eb"
				table:      "offline_bundle"
				durability: "tab"
				seed: [
					{
						id:              "sao-paulo"
						title:           "São Paulo Metro"
						coverage:        "W50_S25 · Greater SP & Serra do Mar"
						size_label:      "18.4 MB"
						status:          "available"
						segments_cached: 0
						pmtiles_ready:   "no"
					},
					{
						id:              "london"
						title:           "Greater London & England"
						coverage:        "W5_N50 + E0_N50 · Thames Valley, Wales & Surrey"
						size_label:      "24.1 MB"
						status:          "available"
						segments_cached: 0
						pmtiles_ready:   "no"
					},
					{
						id:              "scotland"
						title:           "Scotland & Highlands"
						coverage:        "W5_N55 + W5_N60 · Cairngorms, Edinburgh & Orkney"
						size_label:      "15.6 MB"
						status:          "available"
						segments_cached: 0
						pmtiles_ready:   "no"
					},
					{
						id:              "ireland"
						title:           "Ireland & West Coast"
						coverage:        "W10_N50 + W10_N55 + W15_N50 · Wild Atlantic Way"
						size_label:      "19.2 MB"
						status:          "available"
						segments_cached: 0
						pmtiles_ready:   "no"
					},
				]
				fields: [
					{ordinal: 1, name: "id", type: "string", pk: true, cel: "this in ['sao-paulo', 'london', 'scotland', 'ireland']"},
					{ordinal: 2, name: "title", type: "string", cel: "this.size() <= 120"},
					{ordinal: 3, name: "coverage", type: "string", cel: "this.size() <= 240"},
					{ordinal: 4, name: "size_label", type: "string", cel: "this.size() <= 64"},
					{ordinal: 5, name: "status", type: "string", cel: "this in ['available', 'downloading', 'installed', 'error']"},
					{ordinal: 6, name: "segments_cached", type: "int32", cel: "this >= 0"},
					{ordinal: 7, name: "pmtiles_ready", type: "string", cel: "this in ['yes', 'no']"},
				]
			}
		}

		cortex: (pronto.#CortexComposition & {
			root: _gabiRouterRoot
			entities: {}
		}).out
	}

	capabilities: {
		blobs: false
		resources: {
			nominatim: {
				kind:   "connect"
				source: "https://nominatim.openstreetmap.org"
				note:   "OpenStreetMap Nominatim place search and reverse geocoding in shell/units/geocoder/unit.js"
			}
			rd5tiles: {
				kind:   "connect"
				source: "https://tiles.surita.dev"
				note:   "BRouter .rd5 routing graph segments and PMTiles regional extracts in shell/units/brouter/unit.js"
			}
			openfreemap: {
				kind:   "connect"
				source: "https://tiles.openfreemap.org"
				note:   "OpenFreeMap Liberty and Positron vector basemap styles in shell/units/router-map/index.html"
			}
			osmtiles: {
				kind:   "img"
				source: "https://tile.openstreetmap.org"
				note:   "OpenStreetMap standard raster tiles in shell/units/router-map/index.html"
			}
			cyclosm: {
				kind:   "img"
				source: "https://a.tile-cyclosm.openstreetmap.fr"
				note:   "CyclOSM cycling raster tiles in shell/units/router-map/index.html"
			}
		}
		hatches: {
			"gpx-io": {
				kind:  "host-dom"
				src:   "shell/hatches/gpx-io.js"
				files: ["shell/hatches/gpx-io.js"]
				note:  "Browser File input picker for .gpx upload, Blob anchor download for .gpx export, and navigator.clipboard URL copy"
			}
		}
		vendored: {
			brouter: {
				isolation: "agent"
				ports: {
					reads:  ["PlannerState"]
					raises: routed: {}
				}
				memo: {entity: "RouteAnswer", key: ["request_key"]}
				src: "shell/units/brouter/unit.js"
				files: [
					"shell/units/brouter/unit.js",
					"shell/units/brouter/segments/E0_N50.rd5",
					"shell/units/brouter/segments/W5_N50.rd5",
					"shell/units/brouter/segments/W50_S25.rd5",
					"shell/units/brouter/segments/W5_N55.rd5",
					"shell/units/brouter/segments/W5_N60.rd5",
					"shell/units/brouter/segments/W10_N50.rd5",
					"shell/units/brouter/segments/W10_N55.rd5",
					"shell/units/brouter/segments/W15_N50.rd5",
				]
				note:  "brouter-rs + route-tools compiled to WebAssembly with 10 embedded .brf profiles, lookups.dat, IndexedDB .rd5 caching, and GPX map-matching"
			}
			geocoder: {
				isolation: "agent"
				ports: {
					reads:  ["PlannerState"]
					raises: found: {}
				}
				memo: {entity: "PlaceAnswer", key: ["kind", "q", "lang"]}
				src:   "shell/units/geocoder/unit.js"
				files: ["shell/units/geocoder/unit.js"]
				note:  "OpenStreetMap Nominatim geocoder with Web Locks 1100ms rate limit, coordinate parser, and offline landmark catalog"
			}
			"router-map": {
				isolation: "realm"
				grants:    ["geolocation"]
				ports: {
					reads: ["PlannerState"]
					raises: map_action: {
						type: "object"
						fields: {
							action: {type: "string", maxLength: 24, values: ["add_waypoint", "move_waypoint", "remove_waypoint", "delete_waypoint", "set_start", "set_end", "add_via", "add_avoid", "remove_avoid", "clear_avoids", "inspect_point"]}
							index:  {type: "integer", min: -1, max: 128}
							lon:    {type: "string", maxLength: 32}
							lat:    {type: "string", maxLength: 32}
							label:  {type: "string", maxLength: 120}
						}
					}
				}
				src: "shell/units/router-map/index.html"
				files: [
					"shell/units/router-map/index.html",
					"shell/units/router-map/vendor/maplibre-gl.js",
					"shell/units/router-map/vendor/maplibre-gl.css",
					"shell/units/router-map/vendor/pmtiles.js",
				]
				note: "MapLibre GL 5.24.0 interactive map canvas with 4 basemaps, 3D terrain pitch, multi-slot route polylines, elevation hover dot, draggable waypoints, avoid circles, and right-click context menu"
			}
		}
	}

	surface: {
		screens: {
			router: {
				title:   "Gabi's Router"
				route:   "/"
				label:   "nav_router"
				strip:   false
				states:  ["planning"]
				hatches: ["gpx-io"]
				files: {
					shared: []
					renderers: [
						"shell/renderers/elevation-chart.js",
						"shell/renderers/surface-breakdown.js",
					]
				}
				paths: {
					route:   {states: ["planning", "planning"], accepts: ["accept-route", "accept-waypoints", "accept-compare", "accept-analytics"]}
					custom:  {states: ["planning", "planning"], accepts: ["accept-profile-editor", "accept-avoid-gpx"]}
					offline: {states: ["planning", "planning"], accepts: ["accept-offline", "accept-cortex-ui"]}
				}
			}
		}

		handlers: {
			is_key: {
				of:   "router"
				src:  "shell/handlers/is_key.js"
				note: "Keydown guard checking whether the pressed key matches params.key"
			}
			search_submitted: {
				of:   "router"
				src:  "shell/handlers/search_submitted.js"
				note: "Trims and commits the search input into search_q when submitted"
			}
			place_found: {
				of:   "router"
				src:  "shell/handlers/place_found.js"
				note: "Folds a PlaceAnswer memo row from the geocoder unit into PlaceSuggestion rows s0..s4"
			}
			route_answered: {
				of:   "router"
				src:  "shell/handlers/route_answered.js"
				note: "Folds a RouteAnswer memo row from the brouter Wasm unit into RouteSlot rows slot-0..slot-2, OfflineBundle rows, and PlannerState telemetry"
			}
			map_action: {
				of:   "router"
				src:  "shell/handlers/map_action.js"
				note: "Processes map_action events from the router-map realm unit (waypoints, avoid zones, and segment inspection)"
			}
			planner_action: {
				of:   "router"
				src:  "shell/handlers/planner_action.js"
				note: "Handles preset routes, reverse, round-trip loop, slot selection, profile/alternative switching, custom .brf compilation, GPX import, and offline regional bundles"
			}
		}

		design: (pronto.#DesignMd & {text: _designMd}).design
		flows: {}
	}

	meta: {
		name:        "gabis-router"
		domain:      "gabis-router.bonisoft3.com"
		description: "Offline-capable bicycle route planner powered by brouter-rs WebAssembly, MapLibre GL, and Pronto Cortex statecharts."
		favicon: """
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
			  <rect width="64" height="64" rx="16" fill="#0B0D17"/>
			  <path d="M14 46C22 46 24 20 34 20C44 20 42 38 50 18" stroke="#7C6DF5" stroke-width="5" stroke-linecap="round"/>
			  <circle cx="14" cy="46" r="5" fill="#10B981"/>
			  <circle cx="50" cy="18" r="5" fill="#C084FC"/>
			</svg>
			"""
		ir: {sha256: ""}
		targets: ["cloudflare"]
		i18n: {
			default: "en"
			locales: {
				"en":    path: "en"
				"pt-BR": path: "pt-br"
			}
			catalogues: _catalogues
		}
		decisions: {
			"decision-wasm-brouter-agent": {}
			"decision-maplibre-realm": {}
			"decision-cortex-row-machines": {}
			"decision-escape-hatches": {}
		}
		tests: {
			"test-route": {
				of:    "router"
				says:  "Clicking two or more points on the map or loading a preset computes a bicycle route via the brouter WebAssembly engine and displays distance, duration, ascent, descent, and energy."
				given: {waypoints: 2}
				when:  "compute route"
				then:  "output.distance_m > 0"
			}
			"test-waypoints": {
				of:    "router"
				says:  "Searching for a place via Nominatim geocoding or editing waypoints adds, reverses, loops, or clears waypoints while keeping the route synchronized."
				given: {query: "Trafalgar Square"}
				when:  "search and select place"
				then:  "output.waypoint_count >= 2"
			}
			"test-compare": {
				of:    "router"
				says:  "Up to three routing slots compare distinct cycling profiles and alternative routes simultaneously."
				given: {slots: 3}
				when:  "compare slots"
				then:  "output.slots_ready == 3"
			}
			"test-analytics": {
				of:    "router"
				says:  "The bottom analytics dock renders a pure Jessie slope-colored SVG elevation profile with hover scrubbing and stacked breakdown bars across all 6 tabs."
				given: {tab: "surface"}
				when:  "render analytics"
				then:  "output.svg_valid && output.breakdown_rows > 0"
			}
			"test-profile-editor": {
				of:    "router"
				says:  "The custom .brf studio compiles custom cycling preferences into a live .brf profile and re-routes the active slot."
				given: {profile: "custom"}
				when:  "apply custom brf"
				then:  "output.active_profile == 'custom'"
			}
			"test-avoid-gpx": {
				of:    "router"
				says:  "Avoid areas can be added, resized, and cleared, and routes can be imported, exported as .gpx, or shared via URL."
				given: {avoid_radius_m: 500}
				when:  "add avoid zone and import gpx"
				then:  "output.routed"
			}
			"test-offline": {
				of:    "router"
				says:  "Regional .rd5 routing bundles can be downloaded/removed for offline routing, and right-clicking a road inspects its .rd5 tags."
				given: {region: "sao-paulo"}
				when:  "download bundle and inspect point"
				then:  "output.status == 'installed'"
			}
			"test-cortex-ui": {
				of:    "router"
				says:  "Cortex row statecharts drive theme, unit system, drawer state, basemap style, 3D terrain, map legend, modals, and timed confirmations."
				given: {theme: "dark", units: "imperial"}
				when:  "transition cortex charts"
				then:  "output.theme == 'dark' && output.units == 'imperial'"
			}
		}
	}
}

terminal: (pronto.#DefaultTerminal & {"code": code}).out
terminal: surface: renderers: [
	"shell/renderers/elevation-chart.js",
	"shell/renderers/surface-breakdown.js",
]
cluster: (pronto.#DefaultCluster & {"code": code, statics: terminal.surface.statics}).out
loop:    (pronto.#DefaultLoop & {"code": code, "cluster": cluster, "terminal": terminal}).out

loop: surface: checks: "unit": {
	verb: "test"
	cmds: ["deno test --config tests/deno.json --lock tests/deno.lock --frozen --allow-read tests/handlers.test.ts"]
	note: "Pure Jessie handlers, SVG/HTML renderers, and Wasm worker unit invariants"
}

build: (pronto.#DefaultBuild & {"code": code, "loop": loop, "cluster": cluster, "terminal": terminal}).out

out: pronto.#emit & {"code": code, "cluster": cluster, "terminal": terminal, "loop": loop, "build": build}

_gabiRouterRoot: {
	config: {
		id: "gabi_router"
		meta: host: "omnishell"
		initial: "routing"
		on: {
			"route:router": {target: ".router", reenter: true}
		}
		states: {
			routing: {}
			router: {
				meta: screen: "router"
				invoke: {src: "routerRows"}
				initial: "loading"
				states: {
					loading: {invoke: {src: "navigate", onDone: "ready", onError: "failed"}}
					ready: {}
					failed: {}
				}
			}
		}
	}
	setup: actors: _rowActors & {
		navigate: {via: "navigation"}
	}
}
