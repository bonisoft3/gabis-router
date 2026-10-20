// Pronto specification for the GBRouter frontend.
// All entities have `tab` durability and hydrate `shell/screens/router.html`
// through Omnishell, using Jessie SVG/DOM renderers (`elevation-chart`,
// `surface-breakdown`), handler (`ui-action`), and host-DOM hatch (`router-host`).
package rsrouter

import (
	pronto "github.com/bonisoft3/pronto"
)

code: pronto.#App & {
	state: entities: {
		UiState: {
			id:         "0x710a9c8e12b34001"
			table:      "ui_state"
			durability: "tab"
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true, cel: "this == 'main'"},
				{ordinal: 2, name: "controls_class", type: "string"},
				{ordinal: 3, name: "profile_badge", type: "string"},
				{ordinal: 4, name: "hide_offline_pill", type: "string"},
				{ordinal: 5, name: "collapse_transform", type: "string"},
				{ordinal: 6, name: "hide_add_profile", type: "string"},
				{ordinal: 7, name: "search_placeholder", type: "string"},
				{ordinal: 8, name: "hide_clear_search", type: "string"},
				{ordinal: 9, name: "hide_search_results", type: "string"},
				{ordinal: 10, name: "hide_search_status", type: "string"},
				{ordinal: 11, name: "search_status", type: "string"},
				{ordinal: 12, name: "disable_undo", type: "string"},
				{ordinal: 13, name: "disable_redo", type: "string"},
				{ordinal: 14, name: "disable_reverse", type: "string"},
				{ordinal: 15, name: "disable_clear", type: "string"},
				{ordinal: 16, name: "hide_waypoint_empty", type: "string"},
				{ordinal: 17, name: "hide_avoid_section", type: "string"},
				{ordinal: 18, name: "status_class", type: "string"},
				{ordinal: 19, name: "status_text", type: "string"},
				{ordinal: 20, name: "hide_export_actions", type: "string"},
				{ordinal: 21, name: "disable_export", type: "string"},
				{ordinal: 22, name: "share_btn_text", type: "string"},
				{ordinal: 23, name: "route_info_class", type: "string"},
				{ordinal: 24, name: "hide_route_info", type: "string"},
				{ordinal: 25, name: "hide_settings_modal", type: "string"},
				{ordinal: 26, name: "offline_badge_class", type: "string"},
				{ordinal: 27, name: "offline_badge_text", type: "string"},
				{ordinal: 28, name: "hide_download_card", type: "string"},
				{ordinal: 29, name: "download_msg", type: "string"},
				{ordinal: 30, name: "download_progress_style", type: "string"},
				{ordinal: 31, name: "hide_btn_download", type: "string"},
				{ordinal: 32, name: "btn_download_text", type: "string"},
				{ordinal: 33, name: "hide_btn_delete", type: "string"},
				{ordinal: 34, name: "hide_btn_update", type: "string"},
				{ordinal: 35, name: "disable_btn_update", type: "string"},
				{ordinal: 36, name: "btn_update_text", type: "string"},
				{ordinal: 37, name: "hide_snapshot_date", type: "string"},
				{ordinal: 38, name: "snapshot_date_text", type: "string"},
				{ordinal: 39, name: "tf_key_status", type: "string"},
				{ordinal: 40, name: "hide_about_modal", type: "string"},
			]
		}
		ProfileSlot: {
			id:         "0x710a9c8e12b34002"
			table:      "profile_slot"
			durability: "tab"
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true},
				{ordinal: 2, name: "slot_idx", type: "int32"},
				{ordinal: 3, name: "select_id", type: "string"},
				{ordinal: 4, name: "remove_btn_id", type: "string"},
				{ordinal: 5, name: "profile", type: "string"},
				{ordinal: 6, name: "label", type: "string"},
				{ordinal: 7, name: "summary", type: "string"},
				{ordinal: 8, name: "color_line", type: "string"},
				{ordinal: 9, name: "color_name", type: "string"},
				{ordinal: 10, name: "dot_style", type: "string"},
				{ordinal: 11, name: "hide_compare_chrome", type: "string"},
			]
		}
		SearchResult: {
			id:         "0x710a9c8e12b34003"
			table:      "search_result"
			durability: "tab"
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true},
				{ordinal: 2, name: "idx", type: "int32"},
				{ordinal: 3, name: "item_class", type: "string"},
				{ordinal: 4, name: "title", type: "string"},
				{ordinal: 5, name: "subtitle", type: "string"},
				{ordinal: 6, name: "hide_subtitle", type: "string"},
				{ordinal: 7, name: "lat", type: "double"},
				{ordinal: 8, name: "lon", type: "double"},
				{ordinal: 9, name: "name", type: "string"},
			]
		}
		Waypoint: {
			id:         "0x710a9c8e12b34004"
			table:      "waypoint"
			durability: "tab"
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true},
				{ordinal: 2, name: "idx", type: "int32"},
				{ordinal: 3, name: "badge_class", type: "string"},
				{ordinal: 4, name: "badge_label", type: "string"},
				{ordinal: 5, name: "name_class", type: "string"},
				{ordinal: 6, name: "display_name", type: "string"},
				{ordinal: 7, name: "hide_name_span", type: "string"},
				{ordinal: 8, name: "edit_value", type: "string"},
				{ordinal: 9, name: "hide_rename_input", type: "string"},
				{ordinal: 10, name: "coord_str", type: "string"},
				{ordinal: 11, name: "hide_coords", type: "string"},
				{ordinal: 12, name: "disable_up", type: "string"},
				{ordinal: 13, name: "disable_down", type: "string"},
				{ordinal: 14, name: "lat", type: "double"},
				{ordinal: 15, name: "lon", type: "double"},
				{ordinal: 16, name: "name", type: "string"},
				{ordinal: 17, name: "is_geocoding", type: "string"},
				{ordinal: 18, name: "is_editing", type: "string"},
			]
		}
		AvoidArea: {
			id:         "0x710a9c8e12b34005"
			table:      "avoid_area"
			durability: "tab"
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true},
				{ordinal: 2, name: "idx", type: "int32"},
				{ordinal: 3, name: "label", type: "string"},
				{ordinal: 4, name: "lat", type: "double"},
				{ordinal: 5, name: "lon", type: "double"},
				{ordinal: 6, name: "radius", type: "double"},
				{ordinal: 7, name: "weight", type: "string"},
			]
		}
		RouteBar: {
			id:         "0x710a9c8e12b34006"
			table:      "route_bar"
			durability: "tab"
			fields: [
				{ordinal: 1, name: "id", type: "string", pk: true},
				{ordinal: 2, name: "slot_idx", type: "int32"},
				{ordinal: 3, name: "bar_id", type: "string"},
				{ordinal: 4, name: "card_class", type: "string"},
				{ordinal: 5, name: "card_style", type: "string"},
				{ordinal: 6, name: "hide_profile_pill", type: "string"},
				{ordinal: 7, name: "pill_dot_style", type: "string"},
				{ordinal: 8, name: "label", type: "string"},
				{ordinal: 9, name: "id_distance", type: "string"},
				{ordinal: 10, name: "id_time", type: "string"},
				{ordinal: 11, name: "id_ascent", type: "string"},
				{ordinal: 12, name: "id_descent", type: "string"},
				{ordinal: 13, name: "id_speed", type: "string"},
				{ordinal: 14, name: "distance_str", type: "string"},
				{ordinal: 15, name: "time_str", type: "string"},
				{ordinal: 16, name: "ascent_str", type: "string"},
				{ordinal: 17, name: "descent_str", type: "string"},
				{ordinal: 18, name: "speed_str", type: "string"},
				{ordinal: 19, name: "id_collapse_btn", type: "string"},
				{ordinal: 20, name: "collapse_title", type: "string"},
				{ordinal: 21, name: "id_body", type: "string"},
				{ordinal: 22, name: "hide_body", type: "string"},
				{ordinal: 23, name: "id_elevation_details", type: "string"},
				{ordinal: 24, name: "hide_elevation", type: "string"},
				{ordinal: 25, name: "id_elevation_chart", type: "string"},
				{ordinal: 26, name: "elevation_chart_class", type: "string"},
				{ordinal: 27, name: "hide_readout", type: "string"},
				{ordinal: 28, name: "hover_ele", type: "string"},
				{ordinal: 29, name: "hover_grade", type: "string"},
				{ordinal: 30, name: "hover_grade_style", type: "string"},
				{ordinal: 31, name: "hover_dist", type: "string"},
				{ordinal: 32, name: "hide_hover_surf", type: "string"},
				{ordinal: 33, name: "hover_surf_dot_style", type: "string"},
				{ordinal: 34, name: "hover_surf_label", type: "string"},
				{ordinal: 35, name: "hide_hover_road", type: "string"},
				{ordinal: 36, name: "hover_road_dot_style", type: "string"},
				{ordinal: 37, name: "hover_road_label", type: "string"},
				{ordinal: 38, name: "hide_hover_traffic", type: "string"},
				{ordinal: 39, name: "hover_traffic_dot_style", type: "string"},
				{ordinal: 40, name: "hover_traffic_label", type: "string"},
				{ordinal: 41, name: "hide_hover_noise", type: "string"},
				{ordinal: 42, name: "hover_noise_label", type: "string"},
				{ordinal: 43, name: "hide_hover_speed", type: "string"},
				{ordinal: 44, name: "hover_speed_label", type: "string"},
				{ordinal: 45, name: "chart_spec", type: "string"},
				{ordinal: 46, name: "id_surface_details", type: "string"},
				{ordinal: 47, name: "hide_surface", type: "string"},
				{ordinal: 48, name: "id_surface_section", type: "string"},
				{ordinal: 49, name: "surface_spec", type: "string"},
			]
		}
	}

	capabilities: {
		blobs: false
		hatches: {
			"router-host": {
				src: "shell/hatches/router-host.js"
				targets: ["#map", "#controls", "#route-info", "#settings-modal", "#about-modal"]
				note: "MapLibre GL canvas, WASM BRouter routing engine, OPFS offline bundle manager, and MCP bridge"
			}
		}
		vendored: {}
	}

	surface: {
		screens: {
			router: {
				title: "GBRouter"
				route: "/"
				label: "nav_router"
				states: ["populated"]
				hatches: ["router-host"]
			}
		}
		handlers: {}
		flows: {}
	}
}
