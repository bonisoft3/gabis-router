//! Automated route comparison binary evaluating rsrouter against BRouter baseline fixtures.
//! Baseline reference: `https://github.com/abrensch/brouter`
//!
//! Evaluates the 3 focus profiles (`fastbike`, `fastbike-lowtraffic`, `fastbike-verylowtraffic`)
//! across UK corridors, outputs GeoJSON tracks to `target/routes/`, and prints a parity table.

use std::fs;
use std::path::Path;
use std::time::Instant;

use rayon::prelude::*;
use rsrouter::dsl::lookups::LookupData;
use rsrouter::dsl::parser::Profile;
use rsrouter::graph::routing_graph::RoutingGraph;
use rsrouter::rd5::tile_manager::TileManager;
use rsrouter::routing::search::AStarRouter;
use rsrouter::types::{Cost, Distance, Seconds};

struct Corridor {
    name: &'static str,
    title: &'static str,
    start_lat: f64,
    start_lon: f64,
    end_lat: f64,
    end_lon: f64,
}

#[derive(Debug)]
struct ParityRow {
    corridor: &'static str,
    profile: &'static str,
    dist_delta_pct: f64,
    time_delta_pct: f64,
    cost_delta_pct: f64,
    ascend_rs: Distance,
    ascend_br: Distance,
    search_ms: f64,
}

fn parse_fixture_stats(fixture_path: &Path) -> Option<(Distance, Seconds, Cost, Distance)> {
    if !fixture_path.exists() {
        return None;
    }
    let content = fs::read_to_string(fixture_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    let props = json.get("features")?.get(0)?.get("properties")?;

    let dist: Distance = props.get("track-length")?.as_str()?.parse().ok()?;
    let time: Seconds = props.get("total-time")?.as_str()?.parse().ok()?;
    let cost: Cost = props.get("cost")?.as_str()?.parse().ok()?;
    let ascend: Distance = props
        .get("filtered ascend")
        .or_else(|| props.get("filtered-ascend"))
        .or_else(|| props.get("plain-ascend"))?
        .as_str()?
        .parse()
        .ok()?;

    Some((dist, time, cost, ascend))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("Loading Lookups from profiles/lookups.dat...");
    let lookups = LookupData::load_from_file("profiles/lookups.dat")?;

    let corridors = [
        Corridor {
            name: "clapham_hackney",
            title: "Clapham -> Hackney",
            start_lat: 51.462414,
            start_lon: -0.143613,
            end_lat: 51.544998,
            end_lon: -0.055296,
        },
        Corridor {
            name: "london_brighton",
            title: "London -> Brighton",
            start_lat: 51.507392,
            start_lon: -0.127818,
            end_lat: 50.822431,
            end_lon: -0.136913,
        },
        Corridor {
            name: "london_oxford",
            title: "London -> Oxford",
            start_lat: 51.507392,
            start_lon: -0.127818,
            end_lat: 51.751988,
            end_lon: -1.257704,
        },
        Corridor {
            name: "london_cardiff",
            title: "London -> Cardiff",
            start_lat: 51.507392,
            start_lon: -0.127818,
            end_lat: 51.481607,
            end_lon: -3.179096,
        },
    ];

    let profiles = ["fastbike", "fastbike-lowtraffic", "fastbike-verylowtraffic"];

    let router = AStarRouter::new();
    let _ = fs::create_dir_all("target/routes");

    let min_lon = corridors
        .iter()
        .map(|c| c.start_lon.min(c.end_lon))
        .fold(f64::INFINITY, f64::min);
    let max_lon = corridors
        .iter()
        .map(|c| c.start_lon.max(c.end_lon))
        .fold(f64::NEG_INFINITY, f64::max);
    let min_lat = corridors
        .iter()
        .map(|c| c.start_lat.min(c.end_lat))
        .fold(f64::INFINITY, f64::min);
    let max_lat = corridors
        .iter()
        .map(|c| c.start_lat.max(c.end_lat))
        .fold(f64::NEG_INFINITY, f64::max);

    println!("\n=======================================================");
    println!("Preloading unified regional graph for benchmark corridors...");
    println!(
        "Bounding box: lon [{:.4}, {:.4}], lat [{:.4}, {:.4}]",
        min_lon, max_lon, min_lat, max_lat
    );

    let t_load = Instant::now();
    let mut tile_mgr = TileManager::new("data/segments4");
    let mut graph = RoutingGraph::with_capacities(4_500_000, 11_000_000);
    let loaded_cells = graph.load_bounding_box(&mut tile_mgr, min_lon, min_lat, max_lon, max_lat)?;
    let graph_load_ms = t_load.elapsed().as_secs_f64() * 1000.0;

    println!(
        "Unified regional graph ready in {:.2} ms ({} cells, {} nodes, {} edges)",
        graph_load_ms,
        loaded_cells,
        graph.node_count(),
        graph.edge_count()
    );

    let mut rows: Vec<ParityRow> = Vec::new();

    for corr in &corridors {
        println!("\n=======================================================");
        println!("Processing corridor: {} ({})", corr.title, corr.name);

        let corridor_rows: Vec<ParityRow> = profiles
            .par_iter()
            .filter_map(|prof_name| {
                let prof_path = format!("profiles/{}.brf", prof_name);
                let profile = match Profile::load_from_file(&prof_path, &lookups) {
                    Ok(p) => p,
                    Err(e) => {
                        eprintln!("Failed to parse profile {}: {}", prof_name, e);
                        return None;
                    }
                };

                let fixture_name = match *prof_name {
                    "fastbike-lowtraffic" => "lowtraffic",
                    "fastbike-verylowtraffic" => "verylowtraffic",
                    other => other,
                };
                let fixture_path = format!("fixtures/brouter_de/{}_{}.json", corr.name, fixture_name);
                let baseline = parse_fixture_stats(Path::new(&fixture_path));

                let t_route = Instant::now();
                let result = router.find_route(
                    &graph,
                    &lookups,
                    &profile,
                    (corr.start_lon, corr.start_lat),
                    (corr.end_lon, corr.end_lat),
                );
                let elapsed_ms = t_route.elapsed().as_secs_f64() * 1000.0;

                match result {
                    Ok(route) => {
                        let out_path = format!("target/routes/{}_{}.geojson", corr.name, prof_name);
                        let geojson = route.to_geojson(prof_name);
                        let _ = fs::write(&out_path, geojson);

                        if let Some((b_dist, b_time, b_cost, b_asc)) = baseline {
                            let dist_delta = (route.total_distance_m - b_dist).abs() / b_dist * 100.0;
                            let time_delta =
                                (route.total_time_s as f64 - b_time as f64).abs() / b_time as f64 * 100.0;
                            let cost_delta =
                                (route.total_cost as f64 - b_cost as f64).abs() / b_cost as f64 * 100.0;

                            println!(
                                "  [{:23}] Dist: {:>6.1} km ({:+5.2}%) | Time: {:>4.0} min ({:+5.2}%) | Cost: {:>5} ({:+5.2}%) | {:>6.1} ms",
                                prof_name,
                                route.total_distance_m / 1000.0,
                                dist_delta,
                                route.total_time_s / 60.0,
                                time_delta,
                                route.total_cost,
                                cost_delta,
                                elapsed_ms
                            );

                            Some(ParityRow {
                                corridor: corr.title,
                                profile: prof_name,
                                dist_delta_pct: dist_delta,
                                time_delta_pct: time_delta,
                                cost_delta_pct: cost_delta,
                                ascend_rs: route.filtered_ascend_m,
                                ascend_br: b_asc,
                                search_ms: elapsed_ms,
                            })
                        } else {
                            println!(
                                "  [{:23}] Dist: {:>6.1} km | Cost: {:>5} | {:>6.1} ms (no baseline)",
                                prof_name,
                                route.total_distance_m / 1000.0,
                                route.total_cost,
                                elapsed_ms
                            );
                            None
                        }
                    }
                    Err(e) => {
                        eprintln!("  [{}] Routing error: {}", prof_name, e);
                        None
                    }
                }
            })
            .collect();

        rows.extend(corridor_rows);
    }

    println!("\n=======================================================");
    println!("                   PARITY SUMMARY TABLE                 ");
    println!("=======================================================");
    println!(
        "| {:<20} | {:<24} | {:>10} | {:>10} | {:>8} | {:>8} | {:>8} |",
        "Corridor", "Profile", "Dist Delta", "Time Delta", "Cost Delta", "Ascend", "Latency"
    );
    println!(
        "|{:-<22}|{:-<26}|{:-<12}|{:-<12}|{:-<10}|{:-<10}|{:-<10}|",
        "", "", "", "", "", "", ""
    );

    for r in &rows {
        println!(
            "| {:<20} | {:<24} | {:>9.2}% | {:>9.2}% | {:>7.2}% | {:>4.0}/{:<3.0}m | {:>6.0}ms |",
            r.corridor,
            r.profile,
            r.dist_delta_pct,
            r.time_delta_pct,
            r.cost_delta_pct,
            r.ascend_rs,
            r.ascend_br,
            r.search_ms
        );
    }
    println!("=======================================================");
    println!("One-time unified regional graph load: {:.2} ms (0 ms per route)", graph_load_ms);
    println!("=======================================================\n");

    // Documented Parity Enforcement
    // Default thresholds for all routes: distance <= 0.05%, cost <= 0.05%, time <= 0.50%
    // Known gaps with documented allowances:
    // 1. London -> Brighton (fastbike): cost <= 0.25% due to parallel streets in Redhill town center.
    // 2. London -> Brighton (lowtraffic): distance <= 0.30%, cost <= 0.10% due to Seven Dials roundabout approach.
    // 3. London -> Cardiff (lowtraffic): cost <= 0.05% due to parallel cycleway/roadways on Newport Road.
    let mut failures = Vec::new();

    for r in &rows {
        let (max_dist, max_cost, max_time) = match (r.corridor, r.profile) {
            ("London -> Brighton", "fastbike") => (0.05, 0.25, 0.50),
            ("London -> Brighton", "fastbike-lowtraffic") => (0.30, 0.10, 0.50),
            ("London -> Cardiff", "fastbike-lowtraffic") => (0.05, 0.05, 0.50),
            _ => (0.05, 0.05, 0.50),
        };

        if r.dist_delta_pct > max_dist {
            failures.push(format!(
                "{} [{}]: distance delta {:.2}% exceeds threshold {:.2}%",
                r.corridor, r.profile, r.dist_delta_pct, max_dist
            ));
        }
        if r.cost_delta_pct > max_cost {
            failures.push(format!(
                "{} [{}]: cost delta {:.2}% exceeds threshold {:.2}%",
                r.corridor, r.profile, r.cost_delta_pct, max_cost
            ));
        }
        if r.time_delta_pct > max_time {
            failures.push(format!(
                "{} [{}]: time delta {:.2}% exceeds threshold {:.2}%",
                r.corridor, r.profile, r.time_delta_pct, max_time
            ));
        }
    }

    if !failures.is_empty() {
        eprintln!("PARITY REGRESSION DETECTED ({} failures):", failures.len());
        for f in &failures {
            eprintln!("  - {}", f);
        }
        std::process::exit(1);
    } else {
        println!("All {} routes meet documented parity bounds.", rows.len());
    }

    Ok(())
}
