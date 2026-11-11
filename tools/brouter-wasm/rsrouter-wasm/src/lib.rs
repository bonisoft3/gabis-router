use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use wasm_bindgen::prelude::*;

use brouter_rs::dsl::lookups::LookupData;
use brouter_rs::dsl::parser::Profile;
use brouter_rs::graph::routing_graph::RoutingGraph;
use brouter_rs::rd5::rd5_slice::{LazyRd5Provider, Rd5SegmentReader};
use brouter_rs::routing::nogo::{parse_lonlats, parse_nogos};
use brouter_rs::routing::search::{AStarRouter, RouteRequest, RoutingOptions};
use route_tools::{
    inspect_nearest_way, to_geojson_with_segments, GpxMatchRequest, MapMatchOptions,
    RouteMatcherExt,
};

struct JsRd5SegmentReader {
    size_fn: js_sys::Function,
    read_fn: js_sys::Function,
}

// WASM in the Web Worker executes on a single thread.
unsafe impl Send for JsRd5SegmentReader {}
unsafe impl Sync for JsRd5SegmentReader {}

impl Rd5SegmentReader for JsRd5SegmentReader {
    fn segment_len(&self, segment_name: &str) -> Option<u64> {
        let val = self
            .size_fn
            .call1(&JsValue::NULL, &JsValue::from_str(segment_name))
            .ok()?;
        let len = val.as_f64()?;
        if len > 0.0 {
            Some(len as u64)
        } else {
            None
        }
    }

    fn read_range(&self, segment_name: &str, start: u64, end: u64) -> std::io::Result<Vec<u8>> {
        let val = self
            .read_fn
            .call3(
                &JsValue::NULL,
                &JsValue::from_str(segment_name),
                &JsValue::from_f64(start as f64),
                &JsValue::from_f64(end as f64),
            )
            .map_err(|e| {
                std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("JS read_range failed: {e:?}"),
                )
            })?;
        let arr: js_sys::Uint8Array = val.unchecked_into();
        Ok(arr.to_vec())
    }
}

#[wasm_bindgen]
pub struct WasmRouter {
    lookups: Option<LookupData>,
    profiles: HashMap<String, Profile>,
    graph: RoutingGraph,
    router: AStarRouter,
    lazy_provider: Option<Arc<LazyRd5Provider>>,
}

#[wasm_bindgen]
impl WasmRouter {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        console_error_panic_hook::set_once();
        Self {
            lookups: None,
            profiles: HashMap::new(),
            graph: RoutingGraph::new(),
            router: AStarRouter::new(),
            lazy_provider: None,
        }
    }

    /// Attaches JS callbacks `(size_fn(name) -> number, read_fn(name, start, end) -> Uint8Array)`
    /// for BRouter-style lazy on-demand `MicroCache` cell loading during waypoint snapping and A* search.
    pub fn set_segment_reader(&mut self, size_fn: js_sys::Function, read_fn: js_sys::Function) {
        let reader = Arc::new(JsRd5SegmentReader { size_fn, read_fn });
        let provider = Arc::new(LazyRd5Provider::new(reader));
        self.graph.set_cell_provider(Some(provider.clone()));
        self.lazy_provider = Some(provider);
    }

    /// Drains and returns the names of any `.rd5` segments (e.g. `"W5_N50"`) that were requested
    /// during lazy cell loading while not yet available in the Worker's Blob map.
    pub fn take_missing_segments(&self) -> Vec<String> {
        self.lazy_provider
            .as_ref()
            .map(|p| p.take_missing_segments())
            .unwrap_or_default()
    }

    /// Returns the number of `MicroCache` cells currently decoded in the graph.
    pub fn loaded_cell_count(&self) -> usize {
        self.graph.loaded_cell_count()
    }

    /// Returns the number of interned way and node descriptions currently held in the graph.
    pub fn description_count(&self) -> usize {
        self.graph.descriptions.len() + self.graph.node_descriptions.len()
    }

    /// Clears the loaded routing graph and segment index caches while preserving any attached lazy `CellProvider`.
    pub fn clear_graph(&mut self) {
        self.graph.clear_graph_data();
        if let Some(provider) = &self.lazy_provider {
            provider.clear_cache();
        }
    }

    /// Loads the lookups.dat dictionary from a string.
    pub fn load_lookups(&mut self, text: &str) -> Result<(), JsValue> {
        let lookups = LookupData::parse(text)
            .map_err(|e| JsValue::from_str(&format!("Failed to parse lookups: {e}")))?;
        self.lookups = Some(lookups);
        Ok(())
    }

    /// Loads a BRouter profile (.brf) text and evicts any superseded profile cost tables.
    pub fn load_profile(&mut self, name: &str, content: &str) -> Result<(), JsValue> {
        let Some(lookups) = &self.lookups else {
            return Err(JsValue::from_str("Lookups must be loaded before profiles"));
        };
        let profile = Profile::parse(name, content, lookups)
            .map_err(|e| JsValue::from_str(&format!("Failed to parse profile {name}: {e}")))?;
        self.profiles.insert(name.to_string(), profile);
        self.prune_profile_cost_cache();
        Ok(())
    }

    /// Removes a loaded profile by name and evicts its cached cost table if unused.
    pub fn remove_profile(&mut self, name: &str) {
        if self.profiles.remove(name).is_some() {
            self.prune_profile_cost_cache();
        }
    }

    /// Returns the number of nodes currently loaded in the graph.
    pub fn node_count(&self) -> usize {
        self.graph.node_count()
    }

    /// Returns the number of edges currently loaded in the graph.
    pub fn edge_count(&self) -> usize {
        self.graph.edge_count()
    }

    /// Computes a route for given waypoints ("lon,lat|lon,lat") and returns a GeoJSON string.
    pub fn route(
        &mut self,
        waypoints_str: &str,
        profile_name: &str,
        alternative_idx: usize,
        nogos_str: Option<String>,
    ) -> Result<String, JsValue> {
        let Some(lookups) = &self.lookups else {
            return Err(JsValue::from_str("Lookups not loaded"));
        };
        let Some(profile) = self.profiles.get(profile_name) else {
            return Err(JsValue::from_str(&format!("Profile not found: {profile_name}")));
        };

        let parsed = parse_lonlats(waypoints_str, None).map_err(|e| JsValue::from_str(&e))?;
        let nogos = nogos_str.as_deref().map(parse_nogos).unwrap_or_default();

        let route = self
            .router
            .route(RouteRequest {
                graph: &mut self.graph,
                lookups,
                profile,
                waypoints: &parsed.waypoints,
                options: RoutingOptions {
                    alternative_idx,
                    nogos: &nogos,
                    direct_legs: &parsed.direct_legs,
                    ..Default::default()
                },
            })
            .map_err(|e| JsValue::from_str(&format!("Routing failed: {e}")))?;

        Ok(to_geojson_with_segments(&route, profile_name))
    }

    /// Snaps a GPX XML track to the road network, extracts the minimal set of waypoints
    /// required to reproduce the track within `tolerance_m` for `profile_name`, and returns
    /// a JSON string `{ "waypoints": [{"lon": ..., "lat": ...}], "route": <GeoJSON> }`.
    pub fn match_gpx_waypoints(
        &mut self,
        gpx_xml: &str,
        profile_name: &str,
        tolerance_m: f64,
    ) -> Result<String, JsValue> {
        let Some(lookups) = &self.lookups else {
            return Err(JsValue::from_str("Lookups not loaded"));
        };
        let Some(profile) = self.profiles.get(profile_name) else {
            return Err(JsValue::from_str(&format!("Profile not found: {profile_name}")));
        };
        let mut options = MapMatchOptions::default();
        if tolerance_m > 0.0 {
            options.deviation_tolerance_m = tolerance_m;
        }
        let (waypoints, route) = self
            .router
            .extract_gpx_waypoints(GpxMatchRequest {
                graph: &mut self.graph,
                lookups,
                profile,
                gpx_xml,
                options,
            })
            .map_err(|e| JsValue::from_str(&format!("Map-matching failed: {e}")))?;

        let wps_json: Vec<serde_json::Value> = waypoints
            .into_iter()
            .map(|(lon, lat)| serde_json::json!({ "lon": lon, "lat": lat }))
            .collect();
        let route_val: serde_json::Value =
            serde_json::from_str(&to_geojson_with_segments(&route, profile_name))
                .map_err(|e| JsValue::from_str(&format!("Failed to serialize route GeoJSON: {e}")))?;

        let out = serde_json::json!({
            "waypoints": wps_json,
            "route": route_val,
        });
        Ok(out.to_string())
    }

    /// Inspects the nearest road or path edge within `max_distance_m` of `(lon, lat)`
    /// and returns a JSON string of [`PointWayInfo`] (or `"null"` if no way is within range).
    pub fn inspect_point(
        &mut self,
        lon: f64,
        lat: f64,
        max_distance_m: f64,
    ) -> Result<String, JsValue> {
        let Some(lookups) = &self.lookups else {
            return Err(JsValue::from_str("Lookups not loaded"));
        };
        let info = inspect_nearest_way(&mut self.graph, lookups, lon, lat, max_distance_m);
        serde_json::to_string(&info)
            .map_err(|e| JsValue::from_str(&format!("Failed to serialize point info: {e}")))
    }
}

impl WasmRouter {
    fn prune_profile_cost_cache(&self) {
        let active_hashes: HashSet<u64> =
            self.profiles.values().map(|p| p.content_hash).collect();
        if let Ok(mut cache) = self.graph.profile_cost_cache.write() {
            let before = cache.len();
            cache.retain(|hash, _| active_hashes.contains(hash));
            if cache.len() < before {
                cache.shrink_to_fit();
            }
        }
    }
}
