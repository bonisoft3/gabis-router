use std::collections::HashMap;
use std::sync::Arc;
use wasm_bindgen::prelude::*;

use rsrouter_core::dsl::lookups::LookupData;
use rsrouter_core::dsl::parser::Profile;
use rsrouter_core::graph::routing_graph::RoutingGraph;
use rsrouter_core::rd5::rd5_slice::{LazyRd5Provider, Rd5SegmentReader};
use rsrouter_core::routing::search::AStarRouter;

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

    /// Loads a BRouter profile (.brf) text.
    pub fn load_profile(&mut self, name: &str, content: &str) -> Result<(), JsValue> {
        let Some(lookups) = &self.lookups else {
            return Err(JsValue::from_str("Lookups must be loaded before profiles"));
        };
        let profile = Profile::parse(name, content, lookups)
            .map_err(|e| JsValue::from_str(&format!("Failed to parse profile {name}: {e}")))?;
        self.profiles.insert(name.to_string(), profile);
        Ok(())
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
    pub fn find_route(
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

        let mut waypoints = Vec::new();
        for pair in waypoints_str.split('|') {
            let parts: Vec<&str> = pair.split(',').collect();
            if parts.len() != 2 {
                return Err(JsValue::from_str(&format!("Invalid waypoint format: {pair}")));
            }
            let lon: f64 = parts[0]
                .trim()
                .parse()
                .map_err(|e| JsValue::from_str(&format!("Invalid lon: {e}")))?;
            let lat: f64 = parts[1]
                .trim()
                .parse()
                .map_err(|e| JsValue::from_str(&format!("Invalid lat: {e}")))?;
            waypoints.push((lon, lat));
        }

        if waypoints.len() < 2 {
            return Err(JsValue::from_str("At least two waypoints required"));
        }

        let nogos = nogos_str
            .as_deref()
            .map(rsrouter_core::routing::parse_nogos)
            .unwrap_or_default();

        let route = self
            .router
            .find_multi_route_with_alternative_and_nogos_lazy(
                &mut self.graph,
                lookups,
                profile,
                &waypoints,
                alternative_idx,
                &nogos,
            )
            .map_err(|e| JsValue::from_str(&format!("Routing failed: {e}")))?;

        Ok(route.to_geojson(profile_name))
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
        let mut opts = rsrouter_core::routing::MapMatchOptions::default();
        if tolerance_m > 0.0 {
            opts.deviation_tolerance_m = tolerance_m;
        }
        let (waypoints, route) = self
            .router
            .match_gpx_with_minimal_waypoints_lazy(
                &mut self.graph,
                lookups,
                profile,
                gpx_xml,
                &opts,
            )
            .map_err(|e| JsValue::from_str(&format!("Map-matching failed: {e}")))?;

        let wps_json: Vec<serde_json::Value> = waypoints
            .into_iter()
            .map(|(lon, lat)| serde_json::json!({ "lon": lon, "lat": lat }))
            .collect();
        let route_val: serde_json::Value = serde_json::from_str(&route.to_geojson(profile_name))
            .map_err(|e| JsValue::from_str(&format!("Failed to serialize route GeoJSON: {e}")))?;

        let out = serde_json::json!({
            "waypoints": wps_json,
            "route": route_val,
        });
        Ok(out.to_string())
    }
}
