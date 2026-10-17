//! Rust implementation corresponding to:
//! - Java class: `btools.server.RouteServer`
//! - Java source: `https://github.com/abrensch/brouter/blob/master/brouter-server/src/main/java/btools/server/RouteServer.java`
//! - Java class: `btools.server.BRouter`
//! - Java source: `https://github.com/abrensch/brouter/blob/master/brouter-server/src/main/java/btools/server/BRouter.java`
//! - Java class: `btools.server.request.ProfileUploadHandler`
//! - Java source: `https://github.com/abrensch/brouter/blob/master/brouter-server/src/main/java/btools/server/request/ProfileUploadHandler.java`
//!
//! # Summary
//! Drop-in HTTP API server matching BRouter's `/brouter` GET endpoint and `/brouter/profile` POST endpoint.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use serde::Deserialize;

use rsrouter_core::dsl::lookups::LookupData;
use rsrouter_core::dsl::parser::Profile;
use rsrouter_core::graph::routing_graph::RoutingGraph;
use rsrouter_core::rd5::tile_manager::TileManager;
use rsrouter_core::routing::search::{AStarRouter, RoutingOptions};
use rsrouter_core::routing::{parse_nogo_polygons, parse_nogos};

static CUSTOM_PROFILE_COUNTER: AtomicU64 = AtomicU64::new(1);
const MAX_CUSTOM_PROFILE_LEN: usize = 100_000;

/// Query parameters accepted by the BRouter HTTP API (`/brouter`).
///
/// Matches the query schema of `btools.server.BRouter` and `btools.router.RoutingParamCollector`:
/// - `lonlats`: pipe (`|`) or semicolon (`;`) separated list of coordinate pairs `lon,lat[,d]`.
/// - `profile`: profile name without extension, e.g. `fastbike`, or `custom_<id>`.
/// - `customprofile`: inline `.brf` profile source code.
/// - `alternativeidx`: index for alternative routes (0..=3, default 0).
/// - `format` / `trackFormat`: output format (`geojson`, `gpx`, or `kml`).
/// - `nogos`: semicolon-separated no-go circles `lon,lat,radius[,weight]`.
/// - `polylines`: semicolon-separated no-go polylines `lon1,lat1,lon2,lat2[,weight]`.
/// - `polygons`: semicolon-separated no-go polygons `lon1,lat1,lon2,lat2,lon3,lat3[,weight]`.
/// - `timode` / `turnInstructionMode` / `turnInstructionFormat`: turn instruction mode (`0..=9`).
/// - `heading` / `direction`: departure compass heading in degrees (`0..360`).
/// - `straight`: comma-separated 0-based waypoint indices for direct beeline segments.
#[derive(Debug, Default, Deserialize)]
pub struct BRouterQueryParams {
    pub lonlats: Option<String>,
    pub profile: Option<String>,
    pub customprofile: Option<String>,
    pub alternativeidx: Option<usize>,
    pub format: Option<String>,
    #[serde(rename = "trackFormat")]
    pub track_format: Option<String>,
    pub nogos: Option<String>,
    pub polylines: Option<String>,
    pub polygons: Option<String>,
    pub timode: Option<i32>,
    #[serde(rename = "turnInstructionMode")]
    pub turn_instruction_mode: Option<i32>,
    #[serde(rename = "turnInstructionFormat")]
    pub turn_instruction_format: Option<String>,
    pub heading: Option<f64>,
    pub direction: Option<f64>,
    pub straight: Option<String>,
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
    /// Creates a `ServerState` with an existing shared `RoutingGraph`.
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

    /// Creates a `ServerState` preloaded with a regional graph for the specified bounding box.
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

    /// Creates a `ServerState` with the default regional bounds covering southern/central UK.
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
        .route("/brouter/mapmatch", post(handle_map_match))
        .route("/mapmatch", post(handle_map_match))
        .route("/brouter/profile", post(handle_profile_upload))
        .route("/brouter/profile/:id", post(handle_profile_upload_with_id))
        .route("/profile", post(handle_profile_upload))
        .route("/profile/:id", post(handle_profile_upload_with_id))
        .route("/health", get(handle_health))
        .with_state(state)
}

async fn handle_health() -> &'static str {
    "{\"status\":\"ok\",\"engine\":\"rsrouter\"}"
}

async fn handle_profile_upload(
    State(state): State<Arc<ServerState>>,
    body: String,
) -> Response {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = CUSTOM_PROFILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let id = format!("{millis}_{seq}");
    process_profile_upload(&state, &id, &body)
}

async fn handle_profile_upload_with_id(
    State(state): State<Arc<ServerState>>,
    Path(raw_id): Path<String>,
    body: String,
) -> Response {
    let id = raw_id.strip_prefix("custom_").unwrap_or(&raw_id);
    process_profile_upload(&state, id, &body)
}

fn process_profile_upload(state: &ServerState, id: &str, body: &str) -> Response {
    let profile_id = format!("custom_{id}");
    if body.len() > MAX_CUSTOM_PROFILE_LEN {
        let err_json = serde_json::json!({
            "profileid": profile_id,
            "error": format!("Maximum number of characters exceeded ({MAX_CUSTOM_PROFILE_LEN}, {id})"),
        });
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .header("Content-Type", "application/json")
            .body(err_json.to_string().into())
            .unwrap();
    }

    match Profile::parse(&profile_id, body, &state.lookups) {
        Ok(parsed) => {
            let mut cache = state.cached_profiles.write().unwrap();
            cache.insert(profile_id.clone(), Arc::new(parsed));
            let ok_json = serde_json::json!({
                "profileid": profile_id,
            });
            Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "application/json")
                .body(ok_json.to_string().into())
                .unwrap()
        }
        Err(e) => {
            let err_json = serde_json::json!({
                "profileid": profile_id,
                "error": format!("Profile error: {e}"),
            });
            Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "application/json")
                .body(err_json.to_string().into())
                .unwrap()
        }
    }
}

async fn handle_brouter(
    State(state): State<Arc<ServerState>>,
    Query(params): Query<BRouterQueryParams>,
) -> Response {
    let lonlats_str = match params.lonlats {
        Some(ref s) if !s.is_empty() => s.as_str(),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                "Missing 'lonlats' parameter (format: lon1,lat1|lon2,lat2)",
            )
                .into_response();
        }
    };

    let profile_name = params.profile.as_deref().unwrap_or("fastbike");

    let profile = if let Some(ref inline_src) = params.customprofile {
        let inline_name = format!(
            "inline_{}",
            CUSTOM_PROFILE_COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        match Profile::parse(&inline_name, inline_src, &state.lookups) {
            Ok(p) => Arc::new(p),
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    format!("Failed to parse inline customprofile: {e}"),
                )
                    .into_response();
            }
        }
    } else {
        match state.get_profile(profile_name) {
            Ok(p) => p,
            Err(e) => {
                return (StatusCode::BAD_REQUEST, e).into_response();
            }
        }
    };

    let pairs: Vec<&str> = lonlats_str
        .split(['|', ';'])
        .filter(|s| !s.trim().is_empty())
        .collect();
    if pairs.len() < 2 {
        return (
            StatusCode::BAD_REQUEST,
            "At least two waypoints required in 'lonlats'",
        )
            .into_response();
    }

    let mut coords = Vec::with_capacity(pairs.len());
    let mut direct_flags = vec![false; pairs.len()];
    for (idx, pair) in pairs.iter().enumerate() {
        let parts: Vec<&str> = pair.split(',').collect();
        if parts.len() < 2 {
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
        if parts.len() > 2 && parts[2].trim().eq_ignore_ascii_case("d") {
            direct_flags[idx] = true;
        }
        coords.push((lon, lat));
    }

    if let Some(ref straight_str) = params.straight {
        for token in straight_str.split(',') {
            if let Ok(idx) = token.trim().parse::<usize>() {
                if idx < direct_flags.len() {
                    direct_flags[idx] = true;
                }
            }
        }
    }

    // Matches RoutingEngine.java: `boolean calcBeeline = startWp.wpttype == MatchedWaypoint.WAYPOINT_TYPE_DIRECT;`
    let mut direct_legs = vec![false; coords.len().saturating_sub(1)];
    for i in 0..direct_legs.len() {
        if direct_flags[i] {
            direct_legs[i] = true;
        }
    }
    if direct_legs.len() == 1 && *direct_flags.last().unwrap_or(&false) {
        direct_legs[0] = true;
    }

    let alt_idx = params.alternativeidx.unwrap_or(0);
    if alt_idx > 3 {
        return (
            StatusCode::BAD_REQUEST,
            "alternativeidx must be between 0 and 3",
        )
            .into_response();
    }

    let format = params
        .format
        .as_deref()
        .or(params.track_format.as_deref())
        .unwrap_or("geojson");

    let mut nogos = params
        .nogos
        .as_deref()
        .map(parse_nogos)
        .unwrap_or_default();
    if let Some(ref polylines_str) = params.polylines {
        nogos.extend(parse_nogo_polygons(polylines_str, false));
    }
    if let Some(ref polygons_str) = params.polygons {
        nogos.extend(parse_nogo_polygons(polygons_str, true));
    }

    let turn_instruction_mode = params
        .timode
        .or(params.turn_instruction_mode)
        .or_else(|| {
            params.turn_instruction_format.as_deref().and_then(|fmt| {
                if fmt.eq_ignore_ascii_case("osmand") {
                    Some(3)
                } else if fmt.eq_ignore_ascii_case("locus") {
                    Some(2)
                } else {
                    None
                }
            })
        });

    let (start_direction, force_start_direction) = if let Some(h) = params.heading {
        (Some(h), true)
    } else if let Some(d) = params.direction {
        (Some(d), false)
    } else {
        (None, false)
    };

    let options = RoutingOptions {
        alternative_idx: alt_idx,
        nogos: &nogos,
        start_direction,
        force_start_direction,
        turn_instruction_mode,
        direct_legs: &direct_legs,
    };

    match state.router.find_multi_route_with_options(
        &state.graph,
        &state.lookups,
        &profile,
        &coords,
        &options,
    ) {
        Ok(route) => format_route_response(&route, profile_name, format),
        Err(e) => (StatusCode::NOT_FOUND, format!("Routing failed: {}", e)).into_response(),
    }
}

#[derive(Debug, Default, Deserialize)]
pub struct MapMatchQueryParams {
    pub profile: Option<String>,
    pub format: Option<String>,
    #[serde(rename = "trackFormat")]
    pub track_format: Option<String>,
    pub timode: Option<i32>,
    #[serde(rename = "turnInstructionMode")]
    pub turn_instruction_mode: Option<i32>,
    pub sample_step_m: Option<f64>,
    pub rdp_tolerance_m: Option<f64>,
    pub max_snap_distance_m: Option<f64>,
}

async fn handle_map_match(
    State(state): State<Arc<ServerState>>,
    Query(params): Query<MapMatchQueryParams>,
    body: String,
) -> Response {
    if body.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            "Missing GPX XML or coordinate trace in request body",
        )
            .into_response();
    }

    let profile_name = params.profile.as_deref().unwrap_or("fastbike");
    let profile = match state.get_profile(profile_name) {
        Ok(p) => p,
        Err(e) => return (StatusCode::BAD_REQUEST, e).into_response(),
    };

    let track_points = if body.contains('<') {
        match rsrouter_core::routing::parse_gpx_points(&body) {
            Ok(pts) => pts,
            Err(e) => return (StatusCode::BAD_REQUEST, e).into_response(),
        }
    } else {
        let mut pts = Vec::new();
        for pair in body.split(['|', ';', '\n']).map(str::trim).filter(|s| !s.is_empty()) {
            let parts: Vec<&str> = pair.split(',').collect();
            if parts.len() < 2 {
                return (
                    StatusCode::BAD_REQUEST,
                    format!("Invalid coordinate pair in trace: {pair}"),
                )
                    .into_response();
            }
            let Ok(lon) = parts[0].trim().parse::<f64>() else {
                return (StatusCode::BAD_REQUEST, "Invalid longitude").into_response();
            };
            let Ok(lat) = parts[1].trim().parse::<f64>() else {
                return (StatusCode::BAD_REQUEST, "Invalid latitude").into_response();
            };
            pts.push((lon, lat));
        }
        if pts.len() < 2 {
            return (
                StatusCode::BAD_REQUEST,
                "At least 2 track points are required for map-matching",
            )
                .into_response();
        }
        pts
    };

    let mut mm_opts = rsrouter_core::routing::MapMatchOptions::default();
    if let Some(step) = params.sample_step_m {
        mm_opts.sample_step_m = step;
    }
    if let Some(tol) = params.rdp_tolerance_m {
        mm_opts.rdp_tolerance_m = tol;
    }
    if let Some(snap_dist) = params.max_snap_distance_m {
        mm_opts.max_snap_distance_m = snap_dist;
    }
    mm_opts.turn_instruction_mode = params.timode.or(params.turn_instruction_mode);

    let format = params
        .format
        .as_deref()
        .or(params.track_format.as_deref())
        .unwrap_or("geojson");

    match state
        .router
        .match_track_points(&state.graph, &state.lookups, &profile, &track_points, &mm_opts)
    {
        Ok(route) => format_route_response(&route, profile_name, format),
        Err(e) => (StatusCode::NOT_FOUND, format!("Map-matching failed: {e}")).into_response(),
    }
}

fn format_route_response(
    route: &rsrouter_core::routing::RouteResult,
    profile_name: &str,
    format: &str,
) -> Response {
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
    } else if format.eq_ignore_ascii_case("kml") {
        let kml = route.to_kml(profile_name);
        Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", "application/vnd.google-earth.kml+xml")
            .header(
                "Content-Disposition",
                format!("attachment; filename=\"{profile_name}.kml\""),
            )
            .body(kml.into())
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
