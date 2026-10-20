//! Integration tests for `route-tools`: GPX map-matching, minimal waypoint extraction,
//! surface/highway segment breakdowns, and custom product profiles.

use std::path::{Path, PathBuf};

use brouter_rs::rd5::tile_manager::TileManager;
use brouter_rs::{AStarRouter, LookupData, Profile, RouteRequest, RoutingGraph, RoutingOptions};

use route_tools::{
    extract_route_segments, to_geojson_with_segments, GpxMatchRequest, MapMatchOptions,
    RouteMatcherExt,
};

fn repo_path(rel: &str) -> PathBuf {
    let p = Path::new(rel);
    if p.exists() {
        return p.to_path_buf();
    }
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .map(|root| root.join(rel))
        .unwrap_or_else(|| PathBuf::from(rel))
}

#[test]
fn test_gpx_map_matching_and_via_correction() {
    let segment_path = repo_path("data/segments4/W5_N50.rd5");
    if !segment_path.exists() {
        return;
    }

    let lookups = LookupData::load_from_file(repo_path("profiles/lookups.dat"))
        .expect("Failed to load lookups.dat");
    let profile = Profile::load_from_file(repo_path("profiles/fastbike.brf"), &lookups)
        .expect("Failed to load fastbike profile");

    let mut tile_mgr = TileManager::new(repo_path("data/segments4"));
    let microcaches = tile_mgr
        .decode_all_in_square(179, 141, None)
        .expect("Failed to decode square (179, 141)");

    let mut graph = RoutingGraph::with_capacities(100_000, 250_000);
    for cache in microcaches {
        graph.add_micro_cache(cache);
    }
    graph.resolve_edge_target_elevations();

    let start = (-0.143613, 51.462414);
    let target = (-0.125000, 51.482000);
    let router = AStarRouter::new();

    let reference_route = router
        .query(&graph, &lookups, &profile, &[start, target])
        .compute()
        .expect("Reference route failed");

    // Verify segment extraction and enriched GeoJSON
    let segments = extract_route_segments(&reference_route);
    assert!(!segments.is_empty(), "Expected non-empty route segments");
    let enriched_geojson = to_geojson_with_segments(&reference_route, "fastbike");
    assert!(enriched_geojson.contains("\"segments\""));

    // Build a simulated noisy GPX trace from the reference route
    let mut gpx_xml = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><gpx version=\"1.1\"><trk><trkseg>\n",
    );
    for (i, pt) in reference_route.points.iter().enumerate() {
        let is_endpoint = i == 0 || i == reference_route.points.len() - 1;
        let jitter = if is_endpoint {
            0.0
        } else if i % 2 == 0 {
            0.00003
        } else {
            -0.00003
        };
        let lat = pt.lat + jitter;
        let lon = pt.lon - jitter;
        gpx_xml.push_str(&format!("<trkpt lat=\"{lat:.6}\" lon=\"{lon:.6}\"></trkpt>\n"));
        if i == 10 {
            gpx_xml.push_str(&format!("<trkpt lat=\"{lat:.6}\" lon=\"{lon:.6}\"></trkpt>\n"));
        }
    }
    gpx_xml.push_str("</trkseg></trk></gpx>");

    let mm_opts = MapMatchOptions::default();
    let matched_route = router
        .match_gpx(GpxMatchRequest {
            graph: &graph,
            lookups: &lookups,
            profile: &profile,
            gpx_xml: &gpx_xml,
            options: mm_opts.clone(),
        })
        .expect("GPX map-matching failed");

    let dist_delta_pct = (matched_route.total_distance_m - reference_route.total_distance_m).abs()
        / reference_route.total_distance_m
        * 100.0;
    assert!(
        dist_delta_pct < 1.0,
        "Expected map-matched distance within 1% of reference, got {:.3}%",
        dist_delta_pct
    );

    let (min_wps, min_route) = router
        .extract_gpx_waypoints(GpxMatchRequest {
            graph: &graph,
            lookups: &lookups,
            profile: &profile,
            gpx_xml: &gpx_xml,
            options: mm_opts.clone(),
        })
        .expect("Minimal waypoint extraction failed");
    assert_eq!(min_wps.len(), 2);
    assert!((min_route.total_distance_m - reference_route.total_distance_m).abs() < 25.0);

    let detour_via = (-0.148000, 51.472000);
    let detour_ref = router
        .route(RouteRequest {
            graph: &graph,
            lookups: &lookups,
            profile: &profile,
            waypoints: &[start, detour_via, target],
            options: RoutingOptions::default(),
        })
        .expect("Detour reference route failed");
    let detour_gpx = detour_ref.to_gpx("fastbike");
    let detour_full_match = router
        .match_gpx(GpxMatchRequest {
            graph: &graph,
            lookups: &lookups,
            profile: &profile,
            gpx_xml: &detour_gpx,
            options: mm_opts.clone(),
        })
        .expect("Detour full map-match failed");
    let (detour_wps, detour_matched) = router
        .extract_gpx_waypoints(GpxMatchRequest {
            graph: &graph,
            lookups: &lookups,
            profile: &profile,
            gpx_xml: &detour_gpx,
            options: mm_opts,
        })
        .expect("Detour minimal waypoint extraction failed");
    assert_eq!(detour_wps.len(), 3);
    assert!((detour_matched.total_distance_m - detour_full_match.total_distance_m).abs() < 25.0);
}

#[test]
fn test_custom_product_profiles() {
    let segment_path = repo_path("data/segments4/W5_N50.rd5");
    if !segment_path.exists() {
        return;
    }

    let lookups = LookupData::load_from_file(repo_path("profiles/lookups.dat"))
        .expect("Failed to load lookups.dat");

    let mut tile_mgr = TileManager::new(repo_path("data/segments4"));
    let microcaches = tile_mgr
        .decode_all_in_square(179, 141, None)
        .expect("Failed to decode square (179, 141)");

    let mut graph = RoutingGraph::with_capacities(100_000, 250_000);
    for cache in microcaches {
        graph.add_micro_cache(cache);
    }
    graph.resolve_edge_target_elevations();

    let start = (-0.143613, 51.462414);
    let target = (-0.055296, 51.544998);
    let router = AStarRouter::new();

    for prof_name in ["gabis-safe-road", "gabis-fast-city", "gabis-lite-gravel"] {
        let profile = Profile::load_from_file(
            repo_path(&format!("profiles/{prof_name}.brf")),
            &lookups,
        )
        .unwrap_or_else(|e| panic!("Failed to load {prof_name}: {e}"));
        let route = router
            .query(&graph, &lookups, &profile, &[start, target])
            .compute()
            .unwrap_or_else(|e| panic!("Routing failed for {prof_name}: {e}"));
        assert!(route.total_distance_m > 0.0);
        let segs = extract_route_segments(&route);
        assert!(!segs.is_empty());
    }
}
