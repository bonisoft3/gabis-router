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
use std::sync::{Arc, Mutex, RwLock};

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;

use crate::dsl::lookups::LookupData;
use crate::dsl::parser::Profile;
use crate::graph::routing_graph::RoutingGraph;
use crate::rd5::tile_manager::TileManager;
use crate::routing::search::AStarRouter;

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
    pub graph_cache: Mutex<Option<(String, Arc<RoutingGraph>)>>,
    pub router: AStarRouter,
}

impl ServerState {
    pub fn new(segments_dir: PathBuf, profiles_dir: PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
        let lookups_path = profiles_dir.join("lookups.dat");
        let lookups = Arc::new(LookupData::load_from_file(&lookups_path)?);

        Ok(Self {
            segments_dir,
            profiles_dir,
            lookups,
            cached_profiles: RwLock::new(HashMap::new()),
            graph_cache: Mutex::new(None),
            router: AStarRouter::new(),
        })
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

    let start = coords[0];
    let end = coords[coords.len() - 1];

    let margin_lon = 0.15;
    let margin_lat = 0.10;
    let min_lon = (start.0.min(end.0) - margin_lon).clamp(-180.0, 180.0);
    let max_lon = (start.0.max(end.0) + margin_lon).clamp(-180.0, 180.0);
    let min_lat = (start.1.min(end.1) - margin_lat).clamp(-90.0, 90.0);
    let max_lat = (start.1.max(end.1) + margin_lat).clamp(-90.0, 90.0);

    let mut tile_mgr = TileManager::new(&state.segments_dir);
    let mut graph = RoutingGraph::with_capacities(100_000, 250_000);
    if let Err(e) = graph.load_bounding_box(&mut tile_mgr, min_lon, min_lat, max_lon, max_lat) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to load graph data: {}", e),
        )
            .into_response();
    }

    match state.router.find_route(
        &graph,
        &state.lookups,
        &profile,
        start.0,
        start.1,
        end.0,
        end.1,
    ) {
        Ok(route) => {
            let geojson = route.to_geojson(profile_name);
            Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "application/json")
                .body(geojson.into())
                .unwrap()
        }
        Err(e) => (StatusCode::NOT_FOUND, format!("Routing failed: {}", e)).into_response(),
    }
}
