//! Real tests for kinematics, elevation hysteresis, and full route search.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use rsrouter_core::dsl::evaluator::WayCostResult;
use rsrouter_core::dsl::lookups::LookupData;
use rsrouter_core::dsl::parser::Profile;
use rsrouter_core::graph::routing_graph::RoutingGraph;
use rsrouter_core::rd5::tile_manager::TileManager;
use rsrouter_core::routing::cost::KinematicConfig;
use rsrouter_core::routing::path::{ElevationConfig, PathState, SectionInput, StdPathCalculator};
use rsrouter_core::routing::search::AStarRouter;

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
fn test_cubic_speed_solver_and_kinematics() {
    let cfg = KinematicConfig::default();

    // 1. Test cubic solver: 0.225 * v^3 + 8.829 * v = 100
    // At v = 7.024: 0.225 * 346.4 + 8.829 * 7.024 = 77.94 + 62.01 = ~140, wait:
    // Let's test residual directly:
    let a = cfg.s_c_x;
    let f_roll = cfg.total_mass * 9.81 * cfg.c_r; // 90 * 9.81 * 0.01 = 8.829
    let power = cfg.biker_power; // 100 W

    let v = KinematicConfig::solve_cubic(a, f_roll, power);
    let power_calc = (a * v * v + f_roll) * v;
    assert!(
        (power_calc - power).abs() < 0.2,
        "Cubic solver residual too large: computed power={:.2}, expected={:.2}",
        power_calc,
        power
    );
    // Typical cycling speed on flat with 100W is ~25 km/h = ~7 m/s
    let speed_kmh = v * 3.6;
    assert!(
        (20.0..=25.0).contains(&speed_kmh),
        "Expected cycling speed ~21.4 km/h, got {:.1} km/h",
        speed_kmh
    );

    // 2. Test downhill speed: negative incline reduces f_roll, increasing speed
    let (speed_flat, energy_flat) = cfg.compute_speed_and_energy(100.0, 0.0, 0.0);
    let (speed_down, energy_down) = cfg.compute_speed_and_energy(100.0, -0.02, 0.0);
    assert!(
        speed_down > speed_flat,
        "Downhill speed should exceed flat speed"
    );
    assert!(
        energy_down <= energy_flat,
        "Downhill energy should be lower than flat"
    );

    println!(
        "Kinematic test passed: flat speed={:.1} km/h, downhill speed={:.1} km/h",
        speed_flat * 3.6,
        speed_down * 3.6
    );
}

#[test]
fn test_elevation_hysteresis_and_cutoffs() {
    let mut state = PathState::default();
    let elev_cfg = ElevationConfig::default();
    let kinematic_cfg = KinematicConfig::default();

    let mut way_cost = WayCostResult {
        costfactor: 1.25,
        turncost: 90.0,
        uphillcostfactor: 1.25,
        downhillcostfactor: 1.25,
        initialcost: 0.0,
        nodeaccessgranted: true,
        initialclassifier: 0,
        trafficsourcedensity: 0.0,
        istrafficbackbone: false,
        priorityclassifier: 0,
        classifiermask: 0,
        maxspeed: 50.0,
        uphillcost: 60.0,
        downhillcost: 60.0,
        uphillcutoff: 1.5,   // 1.5% cutoff
        downhillcutoff: 1.5, // 1.5% cutoff
        uphillmaxslope: 15.0,
        downhillmaxslope: 15.0,
        uphillmaxslopecost: 0.0,
        downhillmaxslopecost: 0.0,
        ..Default::default()
    };
    way_cost.init_derived();

    // Sub-cutoff slope: 100m distance with 1.0m elevation rise = 1.0% slope (< 1.5% cutoff)
    // Should NOT incur any elevation penalty
    let sec1 = StdPathCalculator::process_section(
        &mut state,
        &way_cost,
        &elev_cfg,
        &kinematic_cfg,
        &SectionInput {
            dist: 100.0,
            delta_h_micros: 1_000_000,
            cos_angle: 1.0, // straight turn
            crossing_penalty: 0,   // no crossing penalty
            is_detail: true,
        },
    );
    assert_eq!(
        sec1.elevation_cost, 0.0,
        "Sub-cutoff slope should have 0 elevation cost"
    );

    // Steeper slope: 1000m distance with 80m rise = 8.0% slope
    // Should fill buffer and incur elevation cost
    let sec2 = StdPathCalculator::process_section(
        &mut state,
        &way_cost,
        &elev_cfg,
        &kinematic_cfg,
        &SectionInput {
            dist: 1000.0,
            delta_h_micros: 80_000_000,
            cos_angle: 1.0,
            crossing_penalty: 0,
            is_detail: true,
        },
    );
    assert!(
        sec2.elevation_cost > 0.0,
        "Steep slope should incur elevation cost"
    );
    assert!(
        sec2.section_cost > 1000.0 * 1.25,
        "Total cost should exceed baseline distance cost"
    );

    println!(
        "Elevation hysteresis test passed: sub-cutoff cost={:.1}, steep slope cost={:.1}",
        sec1.section_cost, sec2.section_cost
    );
}

#[test]
fn test_real_full_route_generation() {
    let segment_path = repo_path("data/segments4/E0_N50.rd5");
    if !segment_path.exists() {
        println!("Skipping real route test: {:?} does not exist", segment_path);
        return;
    }

    println!("Loading Lookups and Fastbike Profile...");
    let lookups =
        LookupData::load_from_file(&repo_path("profiles/lookups.dat")).expect("Failed to load lookups.dat");
    let profile = Profile::load_from_file(&repo_path("profiles/fastbike.brf"), &lookups)
        .expect("Failed to load fastbike profile");

    println!("Loading square (180, 141) into RoutingGraph...");
    let t0 = Instant::now();
    let mut tile_mgr = TileManager::new(repo_path("data/segments4"));
    let microcaches = tile_mgr
        .decode_all_in_square(180, 141, None)
        .expect("Failed to decode square (180, 141)");

    let mut graph = RoutingGraph::with_capacities(50_000, 100_000);
    for cache in microcaches {
        graph.add_micro_cache(cache);
    }
    graph.resolve_edge_target_elevations();
    println!(
        "Graph ready in {:.2} ms (Nodes: {}, Edges: {})",
        t0.elapsed().as_secs_f64() * 1000.0,
        graph.node_count(),
        graph.edge_count()
    );

    // Route coordinates in East London (Woolwich / Greenwich East to Barking)
    // Start: Woolwich / Thamesmead: lon = 0.07, lat = 51.50
    // Target: Barking / East Ham: lon = 0.08, lat = 51.53
    let start_lon = 0.07;
    let start_lat = 51.50;
    let target_lon = 0.08;
    let target_lat = 51.53;

    let router = AStarRouter::new();
    println!("Computing full route using 2-pass guided A*...");
    let t_route = Instant::now();
    let route = router
        .find_route(
            &graph,
            &lookups,
            &profile,
            (start_lon, start_lat),
            (target_lon, target_lat),
        )
        .expect("Route search failed");
    let route_elapsed = t_route.elapsed();

    println!("--- Route Summary ---");
    println!("Total distance: {:.1} meters", route.total_distance_m);
    println!(
        "Total time:     {:.0} seconds ({:.1} min)",
        route.total_time_s,
        route.total_time_s / 60.0
    );
    println!("Total energy:   {:.0} Joules", route.total_energy_j);
    println!("Filtered ascend:{:.1} meters", route.filtered_ascend_m);
    println!("Total cost:     {}", route.total_cost);
    println!("Route points:   {}", route.points.len());
    println!(
        "Search time:    {:.2} ms",
        route_elapsed.as_secs_f64() * 1000.0
    );

    assert!(route.total_distance_m > 3000.0 && route.total_distance_m < 15000.0);
    assert!(route.points.len() > 50);
    assert!(route.total_cost > 0);
    assert!(route.total_time_s > 0.0);

    // Verify GeoJSON format
    let geojson = route.to_geojson("fastbike");
    assert!(geojson.contains("\"FeatureCollection\""));
    assert!(geojson.contains("\"LineString\""));
    assert!(geojson.contains("\"track-length\""));

    // Save GeoJSON route to target dir for verification and inspection
    let _ = fs::create_dir_all("target/routes");
    let _ = fs::write("target/routes/east_london_fastbike.geojson", &geojson);
    println!("Saved route to target/routes/east_london_fastbike.geojson");
}

#[test]
fn test_clapham_hackney_fastbike() {
    let segment_path = repo_path("data/segments4/W5_N50.rd5");
    if !segment_path.exists() {
        println!("Skipping clapham_hackney test: {:?} does not exist", segment_path);
        return;
    }

    let lookups =
        LookupData::load_from_file(&repo_path("profiles/lookups.dat")).expect("Failed to load lookups.dat");
    let profile = Profile::load_from_file(&repo_path("profiles/fastbike.brf"), &lookups)
        .expect("Failed to load fastbike profile");

    println!("Loading square (179, 141) from W5_N50.rd5 into RoutingGraph...");
    let t0 = Instant::now();
    let mut tile_mgr = TileManager::new(repo_path("data/segments4"));
    let microcaches = tile_mgr
        .decode_all_in_square(179, 141, None)
        .expect("Failed to decode square (179, 141)");

    let mut graph = RoutingGraph::with_capacities(100_000, 250_000);
    for cache in microcaches {
        graph.add_micro_cache(cache);
    }
    graph.resolve_edge_target_elevations();
    println!(
        "Graph ready in {:.2} ms (Nodes: {}, Edges: {})",
        t0.elapsed().as_secs_f64() * 1000.0,
        graph.node_count(),
        graph.edge_count()
    );

    // Clapham -> Hackney coordinates
    let start_lon = -0.143613;
    let start_lat = 51.462414;
    let target_lon = -0.055296;
    let target_lat = 51.544998;

    let router = AStarRouter::new();
    println!("Routing Clapham -> Hackney with fastbike...");
    let t_route = Instant::now();
    let route = router
        .find_route(
            &graph,
            &lookups,
            &profile,
            (start_lon, start_lat),
            (target_lon, target_lat),
        )
        .expect("Clapham -> Hackney routing failed");
    let route_elapsed = t_route.elapsed();

    println!("--- Clapham -> Hackney (fastbike) Summary ---");
    println!(
        "Total distance: {:.1} m (BRouter baseline: 13200 m)",
        route.total_distance_m
    );
    println!(
        "Total time:     {:.0} s (BRouter baseline: 2248 s)",
        route.total_time_s
    );
    println!(
        "Total energy:   {:.0} J (BRouter baseline: 224871 J)",
        route.total_energy_j
    );
    println!(
        "Filtered ascend:{:.1} m (BRouter baseline: 12 m)",
        route.filtered_ascend_m
    );
    println!(
        "Total cost:     {} (BRouter baseline: 21851)",
        route.total_cost
    );
    println!("Route points:   {}", route.points.len());
    println!(
        "Search time:    {:.2} ms",
        route_elapsed.as_secs_f64() * 1000.0
    );

    let _ = fs::create_dir_all("target/routes");
    let geojson = route.to_geojson("clapham_hackney_fastbike");
    let _ = fs::write("target/routes/clapham_hackney_fastbike.geojson", &geojson);

    // Enforce exact parity against upstream BRouter baseline
    let dist_diff = (route.total_distance_m - 13200.0).abs();
    assert!(
        dist_diff <= 1.0,
        "Distance divergence > 1m: got {}",
        route.total_distance_m
    );
    assert_eq!(
        route.total_cost, 21851,
        "Cost divergence from BRouter baseline"
    );
    assert_eq!(
        route.points.len(),
        922,
        "Point count divergence from BRouter baseline"
    );
}

#[test]
fn test_clapham_hackney_lowtraffic() {
    let segment_path = repo_path("data/segments4/W5_N50.rd5");
    if !segment_path.exists() {
        println!("Skipping test: {:?} does not exist", segment_path);
        return;
    }

    let lookups =
        LookupData::load_from_file(&repo_path("profiles/lookups.dat")).expect("Failed to load lookups.dat");
    let profile = Profile::load_from_file(&repo_path("profiles/fastbike-lowtraffic.brf"), &lookups)
        .expect("Failed to load fastbike-lowtraffic profile");

    let mut tile_mgr = TileManager::new(repo_path("data/segments4"));
    let microcaches = tile_mgr
        .decode_all_in_square(179, 141, None)
        .expect("Failed to decode square (179, 141)");

    let mut graph = RoutingGraph::with_capacities(100_000, 250_000);
    for cache in microcaches {
        graph.add_micro_cache(cache);
    }
    graph.resolve_edge_target_elevations();

    let start_lon = -0.143613;
    let start_lat = 51.462414;
    let target_lon = -0.055296;
    let target_lat = 51.544998;

    let router = AStarRouter::new();
    println!("Routing Clapham -> Hackney with fastbike-lowtraffic...");
    let t_route = Instant::now();
    let route = router
        .find_route(
            &graph,
            &lookups,
            &profile,
            (start_lon, start_lat),
            (target_lon, target_lat),
        )
        .expect("Clapham -> Hackney lowtraffic routing failed");
    let route_elapsed = t_route.elapsed();

    println!("--- Clapham -> Hackney (fastbike-lowtraffic) Summary ---");
    println!(
        "Total distance: {:.1} m (BRouter baseline: 14291 m)",
        route.total_distance_m
    );
    println!(
        "Total time:     {:.0} s (BRouter baseline: 2431 s)",
        route.total_time_s
    );
    println!(
        "Total energy:   {:.0} J (BRouter baseline: 243111 J)",
        route.total_energy_j
    );
    println!(
        "Filtered ascend:{:.1} m (BRouter baseline: 12 m)",
        route.filtered_ascend_m
    );
    println!(
        "Total cost:     {} (BRouter baseline: 24745)",
        route.total_cost
    );
    println!("Route points:   {}", route.points.len());
    println!(
        "Search time:    {:.2} ms",
        route_elapsed.as_secs_f64() * 1000.0
    );

    let _ = fs::create_dir_all("target/routes");
    let geojson = route.to_geojson("clapham_hackney_fastbike-lowtraffic");
    let _ = fs::write(
        "target/routes/clapham_hackney_fastbike-lowtraffic.geojson",
        &geojson,
    );

    // Enforce exact parity against upstream BRouter baseline
    let dist_diff = (route.total_distance_m - 14291.0).abs();
    assert!(
        dist_diff <= 1.0,
        "Distance divergence > 1m: got {}",
        route.total_distance_m
    );
    assert_eq!(
        route.total_cost, 24745,
        "Cost divergence from BRouter baseline"
    );
    assert_eq!(
        route.points.len(),
        919,
        "Point count divergence from BRouter baseline"
    );
}

#[test]
fn test_clapham_hackney_verylowtraffic() {
    let segment_path = repo_path("data/segments4/W5_N50.rd5");
    if !segment_path.exists() {
        println!("Skipping test: {:?} does not exist", segment_path);
        return;
    }

    let lookups =
        LookupData::load_from_file(&repo_path("profiles/lookups.dat")).expect("Failed to load lookups.dat");
    let profile = Profile::load_from_file(&repo_path("profiles/fastbike-verylowtraffic.brf"), &lookups)
        .expect("Failed to load fastbike-verylowtraffic profile");

    let mut tile_mgr = TileManager::new(repo_path("data/segments4"));
    let microcaches = tile_mgr
        .decode_all_in_square(179, 141, None)
        .expect("Failed to decode square (179, 141)");

    let mut graph = RoutingGraph::with_capacities(100_000, 250_000);
    for cache in microcaches {
        graph.add_micro_cache(cache);
    }
    graph.resolve_edge_target_elevations();

    let start_lon = -0.143613;
    let start_lat = 51.462414;
    let target_lon = -0.055296;
    let target_lat = 51.544998;

    let router = AStarRouter::new();
    println!("Routing Clapham -> Hackney with fastbike-verylowtraffic...");
    let t_route = Instant::now();
    let route = router
        .find_route(
            &graph,
            &lookups,
            &profile,
            (start_lon, start_lat),
            (target_lon, target_lat),
        )
        .expect("Clapham -> Hackney verylowtraffic routing failed");
    let route_elapsed = t_route.elapsed();

    println!("--- Clapham -> Hackney (fastbike-verylowtraffic) Summary ---");
    println!(
        "Total distance: {:.1} m (BRouter baseline: 14254 m)",
        route.total_distance_m
    );
    println!(
        "Total time:     {:.0} s (BRouter baseline: 2423 s)",
        route.total_time_s
    );
    println!(
        "Total energy:   {:.0} J (BRouter baseline: 242346 J)",
        route.total_energy_j
    );
    println!(
        "Filtered ascend:{:.1} m (BRouter baseline: 12 m)",
        route.filtered_ascend_m
    );
    println!(
        "Total cost:     {} (BRouter baseline: 25141)",
        route.total_cost
    );
    println!("Route points:   {}", route.points.len());
    println!(
        "Search time:    {:.2} ms",
        route_elapsed.as_secs_f64() * 1000.0
    );

    let _ = fs::create_dir_all("target/routes");
    let geojson = route.to_geojson("clapham_hackney_fastbike-verylowtraffic");
    let _ = fs::write(
        "target/routes/clapham_hackney_fastbike-verylowtraffic.geojson",
        &geojson,
    );

    // Enforce exact parity against upstream BRouter baseline
    let dist_diff = (route.total_distance_m - 14254.0).abs();
    assert!(
        dist_diff <= 1.0,
        "Distance divergence > 1m: got {}",
        route.total_distance_m
    );
    assert_eq!(
        route.total_cost, 25141,
        "Cost divergence from BRouter baseline"
    );
    assert_eq!(
        route.points.len(),
        881,
        "Point count divergence from BRouter baseline"
    );
}

#[test]
fn test_profile_configs_initialization() {
    let profile_content = r#"
---context:global
assign totalMass = 85.0
assign maxSpeed = 36.0
assign S_C_x = 0.21
assign C_r = 0.008
assign bikerPower = 150.0
assign validForFoot = 0
assign elevationpenaltybuffer = 4.0
assign elevationmaxbuffer = 8.0
assign elevationbufferreduce = 0.0001
"#;
    let lookups =
        LookupData::load_from_file(&repo_path("profiles/lookups.dat")).expect("Failed to load lookups.dat");
    let profile =
        Profile::parse("test_profile", profile_content, &lookups).expect("Profile parse failed");

    let k_cfg = KinematicConfig::from_profile(&profile);
    assert!((k_cfg.total_mass - 85.0).abs() < 1e-5);
    assert!((k_cfg.max_speed - 10.0).abs() < 1e-5);
    assert!((k_cfg.s_c_x - 0.21).abs() < 1e-5);
    assert!((k_cfg.c_r - 0.008).abs() < 1e-5);
    assert!((k_cfg.biker_power - 150.0).abs() < 1e-5);
    assert!(!k_cfg.is_foot_mode);

    let e_cfg = ElevationConfig::from_profile(&profile);
    assert_eq!(e_cfg.penalty_buffer, 4_000_000);
    assert_eq!(e_cfg.max_buffer, 8_000_000);
    assert_eq!(e_cfg.buffer_reduce, 1);
}
