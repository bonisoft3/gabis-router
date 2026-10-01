use std::collections::HashMap;
use wasm_bindgen::prelude::*;

use rsrouter_core::dsl::lookups::LookupData;
use rsrouter_core::dsl::parser::Profile;
use rsrouter_core::graph::routing_graph::RoutingGraph;
use rsrouter_core::routing::search::AStarRouter;

#[wasm_bindgen]
pub struct WasmRouter {
    lookups: Option<LookupData>,
    profiles: HashMap<String, Profile>,
    graph: RoutingGraph,
    router: AStarRouter,
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
        }
    }

    /// Clears the loaded routing graph.
    pub fn clear_graph(&mut self) {
        self.graph = RoutingGraph::new();
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

    /// Adds a single 1°×1° square from RD5 byte data into the routing graph without resolving edges yet.
    pub fn add_rd5_square(
        &mut self,
        data: &[u8],
        lon_deg: i32,
        lat_deg: i32,
    ) -> Result<usize, JsValue> {
        let slice = rsrouter_core::rd5::rd5_slice::Rd5Slice::parse(data)
            .map_err(|e| JsValue::from_str(&format!("Failed to parse RD5 data: {e}")))?;
        let count = self
            .graph
            .add_rd5_slice_square(&slice, lon_deg, lat_deg)
            .map_err(|e| JsValue::from_str(&format!("Failed to add square ({lon_deg}, {lat_deg}): {e}")))?;
        Ok(count)
    }

    /// Resolves target elevations and edge indices for the entire graph.
    pub fn resolve_graph(&mut self) {
        self.graph.resolve_edge_target_elevations();
    }

    /// Loads a single 1°×1° square from RD5 byte data into the routing graph and resolves edges immediately.
    pub fn load_rd5_square(
        &mut self,
        data: &[u8],
        lon_deg: i32,
        lat_deg: i32,
    ) -> Result<usize, JsValue> {
        let slice = rsrouter_core::rd5::rd5_slice::Rd5Slice::parse(data)
            .map_err(|e| JsValue::from_str(&format!("Failed to parse RD5 data: {e}")))?;
        let count = self
            .graph
            .load_rd5_slice_square(&slice, lon_deg, lat_deg)
            .map_err(|e| JsValue::from_str(&format!("Failed to load square ({lon_deg}, {lat_deg}): {e}")))?;
        Ok(count)
    }

    /// Loads all non-empty squares in a 5°×5° segment (e.g. "W5_N50" or "E0_N50") into the routing graph.
    pub fn load_rd5_segment(
        &mut self,
        data: &[u8],
        segment_name: &str,
    ) -> Result<usize, JsValue> {
        let (base_lon, base_lat) = parse_segment_name(segment_name)
            .ok_or_else(|| JsValue::from_str(&format!("Invalid segment name: {segment_name}")))?;

        let slice = rsrouter_core::rd5::rd5_slice::Rd5Slice::parse(data)
            .map_err(|e| JsValue::from_str(&format!("Failed to parse RD5 data: {e}")))?;
        let count = self
            .graph
            .load_rd5_segment(&slice, base_lon, base_lat)
            .map_err(|e| JsValue::from_str(&format!("Failed to load segment {segment_name}: {e}")))?;
        Ok(count)
    }

    /// Computes a route for given waypoints ("lon,lat|lon,lat") and returns a GeoJSON string.
    pub fn find_route(
        &self,
        waypoints_str: &str,
        profile_name: &str,
        alternative_idx: usize,
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
            let lon: f64 = parts[0].trim().parse()
                .map_err(|e| JsValue::from_str(&format!("Invalid lon: {e}")))?;
            let lat: f64 = parts[1].trim().parse()
                .map_err(|e| JsValue::from_str(&format!("Invalid lat: {e}")))?;
            waypoints.push((lon, lat));
        }

        if waypoints.len() < 2 {
            return Err(JsValue::from_str("At least two waypoints required"));
        }

        if self.graph.node_count() == 0 {
            return Err(JsValue::from_str("Routing graph is empty. Please load tile data first."));
        }

        let route = self.router.find_multi_route_with_alternative(
            &self.graph,
            lookups,
            profile,
            &waypoints,
            alternative_idx,
        ).map_err(|e| JsValue::from_str(&format!("Routing failed: {e}")))?;

        Ok(route.to_geojson(profile_name))
    }
}

fn parse_segment_name(name: &str) -> Option<(i32, i32)> {
    let clean = name.strip_suffix(".rd5").unwrap_or(name);
    let parts: Vec<&str> = clean.split('_').collect();
    if parts.len() != 2 {
        return None;
    }
    let lon_part = parts[0];
    let lat_part = parts[1];

    let lon_val: i32 = lon_part[1..].parse().ok()?;
    let lon = if lon_part.starts_with('W') || lon_part.starts_with('w') {
        -lon_val
    } else if lon_part.starts_with('E') || lon_part.starts_with('e') {
        lon_val
    } else {
        return None;
    };

    let lat_val: i32 = lat_part[1..].parse().ok()?;
    let lat = if lat_part.starts_with('S') || lat_part.starts_with('s') {
        -lat_val
    } else if lat_part.starts_with('N') || lat_part.starts_with('n') {
        lat_val
    } else {
        return None;
    };

    Some((lon, lat))
}
