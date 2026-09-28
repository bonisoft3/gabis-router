//! Automated route comparison binary evaluating rsrouter against BRouter baseline fixtures.
//! Baseline reference: `https://github.com/abrensch/brouter`
//!
//! Evaluates the 3 focus profiles (`fastbike`, `fastbike-lowtraffic`, `fastbike-verylowtraffic`)
//! across UK corridors, outputs GeoJSON tracks to `target/routes/`, and prints a parity table.

use std::fs;
use std::path::Path;
use std::time::Instant;

use rsrouter::dsl::lookups::LookupData;
use rsrouter::dsl::parser::Profile;
use rsrouter::graph::routing_graph::RoutingGraph;
use rsrouter::rd5::tile_manager::TileManager;
use rsrouter::routing::search::AStarRouter;

struct Corridor {
    name: &'static str,
    title: &'static str,
    start_lat: f64,
    start_lon: f64,
    end_lat: f64,
    end_lon: f64,
}

#[derive(Debug)]
#[allow(dead_code)]
struct ParityRow {
    corridor: &'static str,
    profile: &'static str,
    dist_rs: f64,
    dist_br: f64,
    dist_delta_pct: f64,
    time_rs: f64,
    time_br: f64,
    time_delta_pct: f64,
    cost_rs: u32,
    cost_br: u32,
    cost_delta_pct: f64,
    ascend_rs: f64,
    ascend_br: f64,
    search_ms: f64,
}

fn parse_fixture_stats(fixture_path: &Path) -> Option<(f64, f64, u32, f64)> {
    if !fixture_path.exists() {
        return None;
    }
    let content = fs::read_to_string(fixture_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    let props = json.get("features")?.get(0)?.get("properties")?;

    let dist: f64 = props.get("track-length")?.as_str()?.parse().ok()?;
    let time: f64 = props.get("total-time")?.as_str()?.parse().ok()?;
    let cost: u32 = props.get("cost")?.as_str()?.parse().ok()?;
    let ascend: f64 = props
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

    let profiles = [
        "fastbike",
        "fastbike-lowtraffic",
        "fastbike-verylowtraffic",
    ];

    let router = AStarRouter::new();
    let _ = fs::create_dir_all("target/routes");

    let mut rows: Vec<ParityRow> = Vec::new();

    for corr in &corridors {
        println!("\n=======================================================");
        println!("Processing corridor: {} ({})", corr.title, corr.name);

        let t_load = Instant::now();
        let mut tile_mgr = TileManager::new("data/segments4");
        let mut graph = RoutingGraph::with_capacities(200_000, 500_000);

        let min_lon = corr.start_lon.min(corr.end_lon);
        let max_lon = corr.start_lon.max(corr.end_lon);
        let min_lat = corr.start_lat.min(corr.end_lat);
        let max_lat = corr.start_lat.max(corr.end_lat);

        let loaded_cells = graph.load_bounding_box(
            &mut tile_mgr,
            min_lon,
            min_lat,
            max_lon,
            max_lat,
        )?;

        println!(
            "Graph ready in {:.2} ms ({} cells, {} nodes, {} edges)",
            t_load.elapsed().as_secs_f64() * 1000.0,
            loaded_cells,
            graph.node_count(),
            graph.edge_count()
        );

        for prof_name in &profiles {
            let prof_path = format!("profiles/{}.brf", prof_name);
            let profile = match Profile::load_from_file(&prof_path, &lookups) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("Failed to parse profile {}: {}", prof_name, e);
                    continue;
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
                corr.start_lon,
                corr.start_lat,
                corr.end_lon,
                corr.end_lat,
            );
            let elapsed_ms = t_route.elapsed().as_secs_f64() * 1000.0;

            match result {
                Ok(route) => {
                    let out_path = format!("target/routes/{}_{}.geojson", corr.name, prof_name);
                    let geojson = route.to_geojson(prof_name);
                    let _ = fs::write(&out_path, geojson);

                    if let Some((b_dist, b_time, b_cost, b_asc)) = baseline {
                        let dist_delta = (route.total_distance_m - b_dist).abs() / b_dist * 100.0;
                        let time_delta = (route.total_time_s - b_time).abs() / b_time * 100.0;
                        let cost_delta = (route.total_cost as f64 - b_cost as f64).abs()
                            / b_cost as f64
                            * 100.0;

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

                        rows.push(ParityRow {
                            corridor: corr.title,
                            profile: prof_name,
                            dist_rs: route.total_distance_m,
                            dist_br: b_dist,
                            dist_delta_pct: dist_delta,
                            time_rs: route.total_time_s,
                            time_br: b_time,
                            time_delta_pct: time_delta,
                            cost_rs: route.total_cost,
                            cost_br: b_cost,
                            cost_delta_pct: cost_delta,
                            ascend_rs: route.filtered_ascend_m,
                            ascend_br: b_asc,
                            search_ms: elapsed_ms,
                        });
                    } else {
                        println!(
                            "  [{:23}] Dist: {:>6.1} km | Cost: {:>5} | {:>6.1} ms (no baseline)",
                            prof_name,
                            route.total_distance_m / 1000.0,
                            route.total_cost,
                            elapsed_ms
                        );
                    }
                }
                Err(e) => {
                    eprintln!("  [{}] Routing error: {}", prof_name, e);
                }
            }
        }
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
    println!("=======================================================\n");

    Ok(())
}
