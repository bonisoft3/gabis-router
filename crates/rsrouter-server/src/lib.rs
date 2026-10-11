//! Rust implementation corresponding to:
//! - Java class: `btools.server.RouteServer`
//! - Java source: `https://github.com/abrensch/brouter/blob/master/brouter-server/src/main/java/btools/server/RouteServer.java`
//! - Java class: `btools.server.BRouter`
//! - Java source: `https://github.com/abrensch/brouter/blob/master/brouter-server/src/main/java/btools/server/BRouter.java`
//!
//! # Summary
//! Drop-in HTTP API server matching BRouter's `/brouter` GET endpoint.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;

use rsrouter_core::dsl::lookups::LookupData;
use rsrouter_core::dsl::parser::Profile;
use rsrouter_core::graph::routing_graph::RoutingGraph;
use rsrouter_core::rd5::tile_manager::TileManager;
use rsrouter_core::routing::search::AStarRouter;

/// Query parameters accepted by the BRouter HTTP API (`/brouter`).
///
/// Matches the query schema of `btools.server.BRouter`:
/// - `lonlats`: pipe-separated list of coordinate pairs, e.g. `lon1,lat1|lon2,lat2`.
/// - `profile`: profile name without extension, e.g. `fastbike` (defaults to `fastbike`).
/// - `alternativeidx`: index for alternative routes (default 0 for primary route; higher indices reserved for alternative routing).
/// - `format`: output format (defaults to GeoJSON FeatureCollection).
#[derive(Debug, Deserialize)]
pub struct BRouterQueryParams {
    pub lonlats: Option<String>,
    pub profile: Option<String>,
    pub alternativeidx: Option<usize>,
    pub format: Option<String>,
}

pub struct ServerState {
    pub segments_dir: PathBuf,
    pub profiles_dir: PathBuf,
    pub lookups: Arc<LookupData>,
    pub cached_profiles: RwLock<HashMap<String, Arc<Profile>>>,
    pub graph: Arc<RoutingGraph>,
    pub router: AStarRouter,
}

impl ServerState {
    /// Creates a ServerState with an existing shared RoutingGraph.
    pub fn with_graph(
        segments_dir: PathBuf,
        profiles_dir: PathBuf,
        graph: Arc<RoutingGraph>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let lookups_path = profiles_dir.join("lookups.dat");
        let lookups = Arc::new(LookupData::load_from_file(&lookups_path)?);

        Ok(Self {
            segments_dir,
            profiles_dir,
            lookups,
            cached_profiles: RwLock::new(HashMap::new()),
            graph,
            router: AStarRouter::new(),
        })
    }

    /// Creates a ServerState preloaded with a regional graph for the specified bounding box.
    pub fn with_bounding_box(
        segments_dir: PathBuf,
        profiles_dir: PathBuf,
        min_lon: f64,
        min_lat: f64,
        max_lon: f64,
        max_lat: f64,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let mut tile_mgr = TileManager::new(&segments_dir);
        let mut graph = RoutingGraph::with_capacities(4_500_000, 11_000_000);
        let _ = graph.load_bounding_box(&mut tile_mgr, min_lon, min_lat, max_lon, max_lat);
        Self::with_graph(segments_dir, profiles_dir, Arc::new(graph))
    }

    /// Backwards-compatible alias for `with_bounding_box`.
    pub fn with_preloaded_bbox(
        segments_dir: PathBuf,
        profiles_dir: PathBuf,
        min_lon: f64,
        min_lat: f64,
        max_lon: f64,
        max_lat: f64,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        Self::with_bounding_box(segments_dir, profiles_dir, min_lon, min_lat, max_lon, max_lat)
    }

    /// Creates a ServerState with the default regional bounds covering southern/central UK.
    pub fn new(
        segments_dir: PathBuf,
        profiles_dir: PathBuf,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        Self::with_bounding_box(segments_dir, profiles_dir, -3.50, 50.70, 0.20, 52.00)
    }

    pub fn get_profile(&self, name: &str) -> Result<Arc<Profile>, String> {
        {
            let cache = self.cached_profiles.read().unwrap();
            if let Some(prof) = cache.get(name) {
                return Ok(Arc::clone(prof));
            }
        }

        let prof_path = self.profiles_dir.join(format!("{}.brf", name));
        if !prof_path.exists() {
            return Err(format!("Profile not found: {}", name));
        }

        let parsed = Profile::load_from_file(&prof_path, &self.lookups)
            .map_err(|e| format!("Failed to parse profile {}: {}", name, e))?;

        let arc_prof = Arc::new(parsed);
        let mut cache = self.cached_profiles.write().unwrap();
        cache.insert(name.to_string(), Arc::clone(&arc_prof));
        Ok(arc_prof)
    }
}

pub fn create_router(state: Arc<ServerState>) -> Router {
    Router::new()
        .route("/brouter", get(handle_brouter))
        .route("/health", get(handle_health))
        .with_state(state)
}

async fn handle_health() -> &'static str {
    "{\"status\":\"ok\",\"engine\":\"rsrouter\"}"
}

async fn handle_brouter(
    State(state): State<Arc<ServerState>>,
    Query(params): Query<BRouterQueryParams>,
) -> Response {
    let lonlats_str = match params.lonlats {
        Some(s) if !s.is_empty() => s,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                "Missing 'lonlats' parameter (format: lon1,lat1|lon2,lat2)",
            )
                .into_response();
        }
    };

    let profile_name = params.profile.as_deref().unwrap_or("fastbike");

    let profile = match state.get_profile(profile_name) {
        Ok(p) => p,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, e).into_response();
        }
    };

    let pairs: Vec<&str> = lonlats_str.split('|').collect();
    if pairs.len() < 2 {
        return (
            StatusCode::BAD_REQUEST,
            "At least two waypoints required in 'lonlats'",
        )
            .into_response();
    }

    let mut coords = Vec::new();
    for pair in pairs {
        let parts: Vec<&str> = pair.split(',').collect();
        if parts.len() != 2 {
            return (
                StatusCode::BAD_REQUEST,
                format!("Invalid waypoint coordinate pair: {}", pair),
            )
                .into_response();
        }
        let lon: f64 = match parts[0].trim().parse() {
            Ok(v) => v,
            Err(_) => return (StatusCode::BAD_REQUEST, "Invalid longitude").into_response(),
        };
        let lat: f64 = match parts[1].trim().parse() {
            Ok(v) => v,
            Err(_) => return (StatusCode::BAD_REQUEST, "Invalid latitude").into_response(),
        };
        coords.push((lon, lat));
    }

    let alt_idx = params.alternativeidx.unwrap_or(0);
    if alt_idx > 3 {
        return (
            StatusCode::BAD_REQUEST,
            "alternativeidx must be between 0 and 3",
        )
            .into_response();
    }

    let format = params.format.as_deref().unwrap_or("geojson");

    match state.router.find_multi_route_with_alternative(
        &state.graph,
        &state.lookups,
        &profile,
        &coords,
        alt_idx,
    ) {
        Ok(route) => {
            if format.eq_ignore_ascii_case("gpx") {
                let gpx = route.to_gpx(profile_name);
                Response::builder()
                    .status(StatusCode::OK)
                    .header("Content-Type", "application/gpx+xml")
                    .header(
                        "Content-Disposition",
                        format!("attachment; filename=\"{profile_name}.gpx\""),
                    )
                    .body(gpx.into())
                    .unwrap()
            } else {
                let geojson = route.to_geojson(profile_name);
                Response::builder()
                    .status(StatusCode::OK)
                    .header("Content-Type", "application/json")
                    .body(geojson.into())
                    .unwrap()
            }
        }
        Err(e) => (StatusCode::NOT_FOUND, format!("Routing failed: {}", e)).into_response(),
    }
}
