//! Rust implementation corresponding to:
//! - Java class: `btools.router.RoutingEngine`
//! - Java source: `https://github.com/abrensch/brouter/blob/master/brouter-core/src/main/java/btools/router/RoutingEngine.java`
//! - Java class: `btools.router.OsmPath`
//! - Java source: `https://github.com/abrensch/brouter/blob/master/brouter-core/src/main/java/btools/router/OsmPath.java`
//! - Java class: `btools.router.OsmPathElement`
//! - Java source: `https://github.com/abrensch/brouter/blob/master/brouter-core/src/main/java/btools/router/OsmPathElement.java`
//!
//! # Summary
//! 2-pass guided A* routing search with dynamic cost-cutting, elevation hysteresis,
//! kinematic speed/power modeling, and GeoJSON route generation.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};

use crate::dsl::evaluator::{ProfileEvaluator, WayCostResult};
use crate::dsl::lookups::LookupData;
use crate::dsl::parser::Profile;
use crate::graph::matcher::MatchedWaypoint;
use crate::graph::routing_graph::RoutingGraph;
use crate::graph::spatial::{
    self, calc_angle, distance, ilat_to_lat, ilon_to_lon, selev_to_elevation,
};
use crate::rd5::micro_cache::DecodedTurnRestriction;
use super::cost::KinematicConfig;
use super::path::{CrossingConfig, ElevationConfig, PathState, StdPathCalculator};

/// A single coordinate point along the computed route.
#[derive(Debug, Clone)]
pub struct RoutePoint {
    pub lon: f64,
    pub lat: f64,
    pub elevation_m: f64,
    pub distance_from_start_m: f64,
    pub time_from_start_s: f64,
    pub energy_j: f64,
    pub cost: u32,
}

/// The final computed route with full metrics.
#[derive(Debug, Clone)]
pub struct RouteResult {
    pub total_distance_m: f64,
    pub total_time_s: f64,
    pub total_energy_j: f64,
    pub total_cost: u32,
    pub filtered_ascend_m: f64,
    pub plain_ascend_m: f64,
    pub points: Vec<RoutePoint>,
}

impl RouteResult {
    /// Formats the route as a BRouter-compatible GeoJSON FeatureCollection.
    pub fn to_geojson(&self, profile_name: &str) -> String {
        let mut coords = String::new();
        for (i, pt) in self.points.iter().enumerate() {
            if i > 0 {
                coords.push_str(",\n          ");
            }
            coords.push_str(&format!("[{:.6}, {:.6}, {:.1}]", pt.lon, pt.lat, pt.elevation_m));
        }

        format!(
            r#"{{
  "type": "FeatureCollection",
  "features": [
    {{
      "type": "Feature",
      "properties": {{
        "creator": "rsrouter",
        "name": "{profile_name}_route",
        "track-length": "{:.0}",
        "filtered ascend": "{:.0}",
        "plain-ascend": "{:.0}",
        "total-time": "{:.0}",
        "total-energy": "{:.0}",
        "cost": "{}"
      }},
      "geometry": {{
        "type": "LineString",
        "coordinates": [
          {}
        ]
      }}
    }}
  ]
}}"#,
            self.total_distance_m,
            self.filtered_ascend_m,
            self.plain_ascend_m,
            self.total_time_s,
            self.total_energy_j,
            self.total_cost,
            coords
        )
    }
}

#[derive(Clone)]
struct SearchNode {
    node_id: u64,
    from_node_id: u64,
    ilon: i32,
    ilat: i32,
    selev: i16,
    cost: u32,
    air_dist: u32,
    priority: u32,
    path_state: PathState,
    prev_lon: i32,
    prev_lat: i32,
    priority_classifier: i32,
    last_classifier: u8,
    _last_initial_cost: f32,
    in_destination: bool,
    can_leave_destination: bool,
    history_idx: usize,
}

impl PartialEq for SearchNode {
    fn eq(&self, other: &Self) -> bool {
        self.priority == other.priority
    }
}

impl Eq for SearchNode {}

impl Ord for SearchNode {
    fn cmp(&self, other: &Self) -> Ordering {
        other.priority.cmp(&self.priority) // min-heap
    }
}

impl PartialOrd for SearchNode {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[allow(dead_code)]
struct HistoryStep {
    node_id: u64,
    from_node_id: u64,
    ilon: i32,
    ilat: i32,
    selev: i16,
    sub_points: Vec<(i32, i32, i16)>,
    dist: f64,
    time: f64,
    energy: f64,
    cost: u32,
    prev_idx: Option<usize>,
    way_cost: Option<WayCostResult>,
}

/// A* router engine implementing 2-pass guided search.
pub struct AStarRouter {
    pub kinematic_cfg: KinematicConfig,
    pub elev_cfg: ElevationConfig,
}

impl Default for AStarRouter {
    fn default() -> Self {
        Self {
            kinematic_cfg: KinematicConfig::default(),
            elev_cfg: ElevationConfig::default(),
        }
    }
}

impl AStarRouter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Computes a complete route between `start` and `target` waypoints.
    pub fn find_route(
        &self,
        graph: &RoutingGraph,
        lookups: &LookupData,
        profile: &Profile,
        start_lon: f64,
        start_lat: f64,
        target_lon: f64,
        target_lat: f64,
    ) -> Result<RouteResult, String> {
        // 1. Snap start and target waypoints
        let start_mwp = graph
            .snap_waypoint("start", start_lon, start_lat, 500.0)
            .ok_or_else(|| "Start position could not be mapped to graph".to_string())?;

        let target_mwp = graph
            .snap_waypoint("target", target_lon, target_lat, 500.0)
            .ok_or_else(|| "Target position could not be mapped to graph".to_string())?;

        let pass1_coeff = profile.get_global_var("pass1coefficient", 1.5) as f64;
        let pass2_coeff = profile.get_global_var("pass2coefficient", 0.0) as f64;

        let t0 = std::time::Instant::now();
        // 2. Run Pass 0 (fast initial search with pass1coefficient)
        let (pass0_res, pass0_links) = self.search_pass(
            graph,
            lookups,
            profile,
            &start_mwp,
            &target_mwp,
            pass1_coeff,
            None,
            None,
        )?;
        let t0_ms = t0.elapsed().as_secs_f64() * 1000.0;

        if pass2_coeff < 0.0 {
            return Ok(pass0_res);
        }

        let t1 = std::time::Instant::now();
        // 3. Run Pass 1 (guided Dijkstra with pass2coefficient bounded by Pass 0)
        let mut pass0_link_map: HashMap<(u64, u64), u32> = HashMap::with_capacity(pass0_links.len());
        for (from, to, cost) in pass0_links {
            pass0_link_map.insert((from, to), cost);
        }

        let cost_cutting_threshold = Some(pass0_res.total_cost + 5000);
        let pass1_res = self.search_pass(
            graph,
            lookups,
            profile,
            &start_mwp,
            &target_mwp,
            pass2_coeff,
            cost_cutting_threshold,
            Some((&pass0_link_map, pass0_res.total_cost)),
        );
        let t1_ms = t1.elapsed().as_secs_f64() * 1000.0;

        println!("    [DEBUG PASS TIMING] Pass 0: {:.1} ms | Pass 1: {:.1} ms", t0_ms, t1_ms);

        match pass1_res {
            Ok((res, _)) => {
                if res.total_cost <= pass0_res.total_cost {
                    Ok(res)
                } else {
                    Ok(pass0_res)
                }
            }
            Err(_) => Ok(pass0_res),
        }
    }

    fn search_pass(
        &self,
        graph: &RoutingGraph,
        lookups: &LookupData,
        profile: &Profile,
        start_mwp: &MatchedWaypoint,
        target_mwp: &MatchedWaypoint,
        air_distance_factor: f64,
        mut max_cost_limit: Option<u32>,
        cost_cutting: Option<(&HashMap<(u64, u64), u32>, u32)>,
    ) -> Result<(RouteResult, Vec<(u64, u64, u32)>), String> {
        let mut evaluator = ProfileEvaluator::new(profile, &lookups.way, &lookups.node);
        let crossing_cfg = CrossingConfig::from_profile(profile);
        let crossing_tag_idx = lookups.node.get_name_idx("estimated_crossing_class");
        let mut node_lookup_buf = vec![0i32; lookups.node.names.len()];
        let mut way_lookup_buf = vec![0i32; lookups.way.names.len()];

        let consider_tr = profile.get_global_var("considerTurnRestrictions", 0.0) != 0.0;
        let is_car_mode = profile.name.starts_with("car");
        let is_bike_mode = !is_car_mode;

        let mut open_set = BinaryHeap::new();
        let mut best_cost: HashMap<(u64, u64), u32> = HashMap::new();
        let mut history: Vec<HistoryStep> = Vec::with_capacity(16384);

        let start_id1 = crate::graph::node::make_node_id(start_mwp.node1_lon, start_mwp.node1_lat);
        let start_id2 = crate::graph::node::make_node_id(start_mwp.node2_lon, start_mwp.node2_lat);

        let target_id1 = crate::graph::node::make_node_id(target_mwp.node1_lon, target_mwp.node1_lat);
        let target_id2 = crate::graph::node::make_node_id(target_mwp.node2_lon, target_mwp.node2_lat);

        let mut best_target_history: Option<usize> = None;
        let mut final_cost = u32::MAX;

        // 1. Check if start and target are on the same segment
        let same_segment = (start_id1 == target_id1 && start_id2 == target_id2)
            || (start_id1 == target_id2 && start_id2 == target_id1);

        if same_segment {
            if let Some(edges) = graph.edges.get(&start_id1) {
                for edge in edges {
                    if edge.target_id == start_id2 {
                        let Some(desc_bytes) = &edge.description else { continue; };
                        let lookup_data = lookups.way.decode(edge.is_reverse, desc_bytes);
                        let way_cost = evaluator.evaluate_way(&lookup_data);
                        if way_cost.costfactor >= 9999.0 { continue; }

                        let s_elev = graph.nodes.get(&start_id1).map(|n| n.selev).unwrap_or(i16::MIN);
                        let t_elev = graph.nodes.get(&start_id2).map(|n| n.selev).unwrap_or(i16::MIN);
                        let full_poly = edge.polyline(start_mwp.node1_lon, start_mwp.node1_lat, s_elev, t_elev);
                        if let Some(sliced) = slice_between_crosspoints(
                            &full_poly,
                            start_mwp.crosspoint_lon,
                            start_mwp.crosspoint_lat,
                            target_mwp.crosspoint_lon,
                            target_mwp.crosspoint_lat,
                        ) {
                            if sliced.len() >= 2 {
                                let mut path_state = PathState::default();
                                let (cost, dist, time, energy, _, _) = process_polyline(
                                    &sliced,
                                    &mut path_state,
                                    &way_cost,
                                    &self.elev_cfg,
                                    &self.kinematic_cfg,
                                    &crossing_cfg,
                                    None,
                                    0,
                                    sliced[0].0,
                                    sliced[0].1,
                                    true,
                                    false,
                                );
                                if cost < final_cost {
                                    final_cost = cost;
                                    let h_idx = history.len();
                                    history.push(HistoryStep {
                                        node_id: 0,
                                        from_node_id: start_id1,
                                        ilon: target_mwp.crosspoint_lon,
                                        ilat: target_mwp.crosspoint_lat,
                                        selev: sliced.last().map(|p| p.2).unwrap_or(i16::MIN),
                                        sub_points: sliced,
                                        dist,
                                        time,
                                        energy,
                                        cost,
                                        prev_idx: None,
                                        way_cost: Some(way_cost.clone()),
                                    });
                                    best_target_history = Some(h_idx);
                                }
                            }
                        }
                    }
                }
            }
        }

        // 2. Seed start search paths
        if start_id1 == start_id2 {
            if let Some(node) = graph.nodes.get(&start_id1) {
                let air_dist = distance(
                    node.ilon,
                    node.ilat,
                    target_mwp.crosspoint_lon,
                    target_mwp.crosspoint_lat,
                );
                let priority = (air_dist * air_distance_factor) as u32;

                let h_idx = history.len();
                history.push(HistoryStep {
                    node_id: start_id1,
                    from_node_id: 0,
                    ilon: node.ilon,
                    ilat: node.ilat,
                    selev: node.selev,
                    sub_points: vec![(node.ilon, node.ilat, node.selev)],
                    dist: 0.0,
                    time: 0.0,
                    energy: 0.0,
                    cost: 0,
                    prev_idx: None,
                    way_cost: None,
                });

                open_set.push(SearchNode {
                    node_id: start_id1,
                    from_node_id: 0,
                    ilon: node.ilon,
                    ilat: node.ilat,
                    selev: node.selev,
                    cost: 0,
                    air_dist: air_dist as u32,
                    priority,
                    path_state: PathState::default(),
                    prev_lon: node.ilon,
                    prev_lat: node.ilat,
                    priority_classifier: 0,
                    last_classifier: 0,
                    _last_initial_cost: 0.0,
                    in_destination: false,
                    can_leave_destination: false,
                    history_idx: h_idx,
                });

                best_cost.insert((0, start_id1), 0);
            }
        } else {
            // Direction A: from start_crosspoint towards start_id2
            if let Some(edges) = graph.edges.get(&start_id1) {
                for edge in edges {
                    if edge.target_id == start_id2 {
                        let Some(desc_bytes) = &edge.description else { continue; };
                        let lookup_data = lookups.way.decode(edge.is_reverse, desc_bytes);
                        let way_cost = evaluator.evaluate_way(&lookup_data);
                        if way_cost.costfactor >= 9999.0 { continue; }

                        let s_node = graph.nodes.get(&start_id1);
                        let t_node = graph.nodes.get(&start_id2);
                        let s_elev = s_node.map(|n| n.selev).unwrap_or(i16::MIN);
                        let t_elev = t_node.map(|n| n.selev).unwrap_or(i16::MIN);
                        let full_poly = edge.polyline(start_mwp.node1_lon, start_mwp.node1_lat, s_elev, t_elev);
                        let sliced = slice_from_crosspoint(
                            &full_poly,
                            start_mwp.crosspoint_lon,
                            start_mwp.crosspoint_lat,
                        );
                        if sliced.len() >= 2 {
                            let mut path_state = PathState::default();
                            let (cost, dist, time, energy, _, _) = process_polyline(
                                &sliced,
                                &mut path_state,
                                &way_cost,
                                &self.elev_cfg,
                                &self.kinematic_cfg,
                                &crossing_cfg,
                                None,
                                0,
                                sliced[0].0,
                                sliced[0].1,
                                true,
                                false,
                            );

                            let mut total_cost = cost;
                            if let Some(target_node) = t_node {
                                if let Some(ref node_desc) = target_node.node_description {
                                    let node_lookup = lookups.node.decode(way_cost.nodeaccessgranted, node_desc);
                                    let node_res = evaluator.evaluate_node(&node_lookup);
                                    if node_res.initialcost >= 1_000_000.0 {
                                        continue;
                                    }
                                    total_cost += node_res.initialcost as u32;
                                }
                            }

                            let air_dist = distance(
                                start_mwp.node2_lon,
                                start_mwp.node2_lat,
                                target_mwp.crosspoint_lon,
                                target_mwp.crosspoint_lat,
                            );
                            let priority = total_cost + (air_dist * air_distance_factor) as u32;

                            let prev_pt = sliced[sliced.len() - 2];
                            let h_idx = history.len();
                            history.push(HistoryStep {
                                node_id: start_id2,
                                from_node_id: start_id1,
                                ilon: start_mwp.node2_lon,
                                ilat: start_mwp.node2_lat,
                                selev: t_elev,
                                sub_points: sliced,
                                dist,
                                time,
                                energy,
                                cost: total_cost,
                                prev_idx: None,
                                way_cost: Some(way_cost.clone()),
                            });

                            let in_destination = (way_cost.classifiermask & 64) != 0;
                            open_set.push(SearchNode {
                                node_id: start_id2,
                                from_node_id: start_id1,
                                ilon: start_mwp.node2_lon,
                                ilat: start_mwp.node2_lat,
                                selev: t_elev,
                                cost: total_cost,
                                air_dist: air_dist as u32,
                                priority,
                                path_state,
                                prev_lon: prev_pt.0,
                                prev_lat: prev_pt.1,
                                priority_classifier: way_cost.priorityclassifier,
                                last_classifier: way_cost.initialclassifier,
                                _last_initial_cost: way_cost.initialcost,
                                in_destination,
                                can_leave_destination: in_destination,
                                history_idx: h_idx,
                            });

                            best_cost.insert((start_id1, start_id2), total_cost);
                        }
                    }
                }
            }

            // Direction B: from start_crosspoint towards start_id1
            if let Some(edges) = graph.edges.get(&start_id2) {
                for edge in edges {
                    if edge.target_id == start_id1 {
                        let Some(desc_bytes) = &edge.description else { continue; };
                        let lookup_data = lookups.way.decode(edge.is_reverse, desc_bytes);
                        let way_cost = evaluator.evaluate_way(&lookup_data);
                        if way_cost.costfactor >= 9999.0 { continue; }

                        let s_node = graph.nodes.get(&start_id2);
                        let t_node = graph.nodes.get(&start_id1);
                        let s_elev = s_node.map(|n| n.selev).unwrap_or(i16::MIN);
                        let t_elev = t_node.map(|n| n.selev).unwrap_or(i16::MIN);
                        let full_poly = edge.polyline(start_mwp.node2_lon, start_mwp.node2_lat, s_elev, t_elev);
                        let sliced = slice_from_crosspoint(
                            &full_poly,
                            start_mwp.crosspoint_lon,
                            start_mwp.crosspoint_lat,
                        );
                        if sliced.len() >= 2 {
                            let mut path_state = PathState::default();
                            let (cost, dist, time, energy, _, _) = process_polyline(
                                &sliced,
                                &mut path_state,
                                &way_cost,
                                &self.elev_cfg,
                                &self.kinematic_cfg,
                                &crossing_cfg,
                                None,
                                0,
                                sliced[0].0,
                                sliced[0].1,
                                true,
                                false,
                            );

                            let mut total_cost = cost;
                            if let Some(target_node) = t_node {
                                if let Some(ref node_desc) = target_node.node_description {
                                    let node_lookup = lookups.node.decode(way_cost.nodeaccessgranted, node_desc);
                                    let node_res = evaluator.evaluate_node(&node_lookup);
                                    if node_res.initialcost >= 1_000_000.0 {
                                        continue;
                                    }
                                    total_cost += node_res.initialcost as u32;
                                }
                            }

                            let air_dist = distance(
                                start_mwp.node1_lon,
                                start_mwp.node1_lat,
                                target_mwp.crosspoint_lon,
                                target_mwp.crosspoint_lat,
                            );
                            let priority = total_cost + (air_dist * air_distance_factor) as u32;

                            let prev_pt = sliced[sliced.len() - 2];
                            let h_idx = history.len();
                            history.push(HistoryStep {
                                node_id: start_id1,
                                from_node_id: start_id2,
                                ilon: start_mwp.node1_lon,
                                ilat: start_mwp.node1_lat,
                                selev: t_elev,
                                sub_points: sliced,
                                dist,
                                time,
                                energy,
                                cost: total_cost,
                                prev_idx: None,
                                way_cost: Some(way_cost.clone()),
                            });

                            let in_destination = (way_cost.classifiermask & 64) != 0;
                            open_set.push(SearchNode {
                                node_id: start_id1,
                                from_node_id: start_id2,
                                ilon: start_mwp.node1_lon,
                                ilat: start_mwp.node1_lat,
                                selev: t_elev,
                                cost: total_cost,
                                air_dist: air_dist as u32,
                                priority,
                                path_state,
                                prev_lon: prev_pt.0,
                                prev_lat: prev_pt.1,
                                priority_classifier: way_cost.priorityclassifier,
                                last_classifier: way_cost.initialclassifier,
                                _last_initial_cost: way_cost.initialcost,
                                in_destination,
                                can_leave_destination: in_destination,
                                history_idx: h_idx,
                            });

                            best_cost.insert((start_id2, start_id1), total_cost);
                        }
                    }
                }
            }
        }

        // Fallback if neither partial edge was formed
        if open_set.is_empty() && final_cost == u32::MAX {
            for &s_id in &[start_id1, start_id2] {
                if let Some(node) = graph.nodes.get(&s_id) {
                    let air_dist = distance(
                        node.ilon,
                        node.ilat,
                        target_mwp.crosspoint_lon,
                        target_mwp.crosspoint_lat,
                    );
                    let priority = (air_dist * air_distance_factor) as u32;

                    let h_idx = history.len();
                    history.push(HistoryStep {
                        node_id: s_id,
                        from_node_id: 0,
                        ilon: node.ilon,
                        ilat: node.ilat,
                        selev: node.selev,
                        sub_points: vec![(node.ilon, node.ilat, node.selev)],
                        dist: 0.0,
                        time: 0.0,
                        energy: 0.0,
                        cost: 0,
                        prev_idx: None,
                        way_cost: None,
                    });

                    open_set.push(SearchNode {
                        node_id: s_id,
                        from_node_id: 0,
                        ilon: node.ilon,
                        ilat: node.ilat,
                        selev: node.selev,
                        cost: 0,
                        air_dist: air_dist as u32,
                        priority,
                        path_state: PathState::default(),
                        prev_lon: node.ilon,
                        prev_lat: node.ilat,
                        priority_classifier: 0,
                        last_classifier: 0,
                        _last_initial_cost: 0.0,
                        in_destination: false,
                        can_leave_destination: false,
                        history_idx: h_idx,
                    });

                    best_cost.insert((0, s_id), 0);
                }
            }
        }

        if open_set.is_empty() && best_target_history.is_none() {
            return Err("Start nodes not found in graph".to_string());
        }

        let mut nodes_popped = 0usize;
        let mut edges_evaluated = 0usize;

        while let Some(curr) = open_set.pop() {
            nodes_popped += 1;
            if curr.priority >= final_cost {
                break;
            }
            if let Some(max_cost) = max_cost_limit {
                if air_distance_factor == 0.0 && curr.cost >= max_cost {
                    break;
                }
                if curr.cost + curr.air_dist > max_cost {
                    continue;
                }
            }

            let curr_edge_key = (curr.from_node_id, curr.node_id);
            if let Some(&recorded_cost) = best_cost.get(&curr_edge_key) {
                if curr.cost > recorded_cost {
                    continue;
                }
            }

            // Standalone target node check
            if target_id1 == target_id2 && curr.node_id == target_id1 {
                if curr.cost < final_cost {
                    final_cost = curr.cost;
                    best_target_history = Some(curr.history_idx);
                    break;
                }
            }

            let Some(edges) = graph.edges.get(&curr.node_id) else {
                continue;
            };

            // Check if curr node has estimated_crossing_class
            let crossing_class = if crossing_cfg.consider_crossing
                && curr.priority_classifier >= crossing_cfg.crossing_prio_h
            {
                if let Some(c_idx) = crossing_tag_idx {
                    if let Some(curr_node) = graph.nodes.get(&curr.node_id) {
                        if let Some(ref desc) = curr_node.node_description {
                            lookups.node.decode_into(&mut node_lookup_buf, false, desc);
                            let v_idx = node_lookup_buf[c_idx];
                            if v_idx > 0
                                && c_idx < lookups.node.values.len()
                                && (v_idx as usize) < lookups.node.values[c_idx].len()
                            {
                                let val_str = &lookups.node.values[c_idx][v_idx as usize].value;
                                val_str.parse::<u8>().ok()
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            };

            for edge in edges {
                edges_evaluated += 1;
                let Some(desc_bytes) = &edge.description else {
                    continue;
                };

                // Prevent immediate backtrack / U-turn
                if curr.from_node_id != 0 && edge.target_id == curr.from_node_id {
                    continue;
                }

                // Decode and evaluate way tags using reusable buffer (zero-alloc)
                lookups.way.decode_into(&mut way_lookup_buf, edge.is_reverse, desc_bytes);
                let way_cost = evaluator.evaluate_way(&way_lookup_buf);

                if way_cost.costfactor >= 9999.0 {
                    continue; // forbidden way
                }

                // Initial cost on classifier change
                let new_classifier = way_cost.initialclassifier;
                let new_initial_cost = way_cost.initialcost;
                let mut classifier_cost = 0u32;
                if new_classifier != 0 && curr.last_classifier != 0 && new_classifier != curr.last_classifier {
                    if new_initial_cost >= 1_000_000.0 {
                        continue;
                    }
                    classifier_cost = new_initial_cost as u32;
                }

                // Destination access logic
                let new_destination = (way_cost.classifiermask & 64) != 0;
                let mut can_leave = curr.can_leave_destination;
                if curr.in_destination && !new_destination {
                    if can_leave {
                        can_leave = false;
                    } else {
                        continue; // cannot re-enter and exit destination street
                    }
                }

                let air_dist = distance(
                    edge.target_lon,
                    edge.target_lat,
                    target_mwp.crosspoint_lon,
                    target_mwp.crosspoint_lat,
                ) as u32;

                if let Some(max_cost) = max_cost_limit {
                    if curr.cost + air_dist > max_cost {
                        continue;
                    }
                }

                let t_elev = graph
                    .nodes
                    .get(&edge.target_id)
                    .map(|n| n.selev)
                    .unwrap_or(curr.selev);

                let poly = edge.polyline(curr.ilon, curr.ilat, curr.selev, t_elev);
                if poly.len() < 2 {
                    continue;
                }

                // Turn restriction check
                if consider_tr && curr.from_node_id != 0 {
                    if let Some(curr_node) = graph.nodes.get(&curr.node_id) {
                        if !curr_node.turn_restrictions.is_empty() {
                            if DecodedTurnRestriction::is_turn_forbidden(
                                &curr_node.turn_restrictions,
                                curr.prev_lon,
                                curr.prev_lat,
                                poly[1].0,
                                poly[1].1,
                                is_bike_mode,
                                is_car_mode,
                            ) {
                                continue; // forbidden turn
                            }
                        }
                    }
                }

                let is_target_link = (curr.node_id == target_id1 && edge.target_id == target_id2)
                    || (curr.node_id == target_id2 && edge.target_id == target_id1);

                if is_target_link {
                    let sliced = slice_to_crosspoint(
                        &poly,
                        target_mwp.crosspoint_lon,
                        target_mwp.crosspoint_lat,
                    );
                    if sliced.len() >= 2 {
                        let mut path_state = curr.path_state.clone();
                        let (mut edge_cost, edge_dist, edge_time, edge_energy, _, _) = process_polyline(
                            &sliced,
                            &mut path_state,
                            &way_cost,
                            &self.elev_cfg,
                            &self.kinematic_cfg,
                            &crossing_cfg,
                            crossing_class,
                            curr.priority_classifier,
                            curr.prev_lon,
                            curr.prev_lat,
                            false,
                            false,
                        );
                        edge_cost += classifier_cost;

                        let target_cost = curr.cost + edge_cost;
                        if target_cost < final_cost {
                            final_cost = target_cost;
                            let h_idx = history.len();
                            history.push(HistoryStep {
                                node_id: 0,
                                from_node_id: curr.node_id,
                                ilon: target_mwp.crosspoint_lon,
                                ilat: target_mwp.crosspoint_lat,
                                selev: sliced.last().map(|p| p.2).unwrap_or(i16::MIN),
                                sub_points: sliced,
                                dist: edge_dist,
                                time: edge_time,
                                energy: edge_energy,
                                cost: target_cost,
                                prev_idx: Some(curr.history_idx),
                                way_cost: Some(way_cost.clone()),
                            });
                            best_target_history = Some(h_idx);
                        }
                    }
                    continue;
                }

                let mut path_state = curr.path_state.clone();
                let (mut edge_cost, edge_dist, edge_time, edge_energy, _, _) = process_polyline(
                    &poly,
                    &mut path_state,
                    &way_cost,
                    &self.elev_cfg,
                    &self.kinematic_cfg,
                    &crossing_cfg,
                    crossing_class,
                    curr.priority_classifier,
                    curr.prev_lon,
                    curr.prev_lat,
                    false,
                    false,
                );
                edge_cost += classifier_cost;

                // Check node costs for target node
                if let Some(target_node) = graph.nodes.get(&edge.target_id) {
                    if let Some(ref node_desc) = target_node.node_description {
                        lookups.node.decode_into(&mut node_lookup_buf, way_cost.nodeaccessgranted, node_desc);
                        let node_res = evaluator.evaluate_node(&node_lookup_buf);
                        if node_res.initialcost >= 1_000_000.0 {
                            continue; // blocked node
                        }
                        edge_cost += node_res.initialcost as u32;
                    }
                }

                let new_cost = curr.cost + edge_cost;

                if let Some((links, pass0_total)) = cost_cutting {
                    if let Some(&p0_link_cost) = links.get(&(curr.node_id, edge.target_id)) {
                        let remaining_p0 = pass0_total.saturating_sub(p0_link_cost);
                        let cost_estimate = new_cost + remaining_p0;
                        if let Some(ref mut max_cost) = max_cost_limit {
                            if cost_estimate < *max_cost {
                                *max_cost = cost_estimate;
                            }
                        }
                    }
                }

                if new_cost >= final_cost {
                    continue;
                }
                if let Some(max_cost) = max_cost_limit {
                    if new_cost + air_dist > max_cost {
                        continue;
                    }
                }

                let edge_key = (curr.node_id, edge.target_id);
                let is_better = match best_cost.get(&edge_key) {
                    Some(&c) => new_cost < c,
                    None => true,
                };

                if is_better {
                    best_cost.insert(edge_key, new_cost);

                    let priority = new_cost + (air_dist as f64 * air_distance_factor) as u32;

                    let prev_pt = poly[poly.len() - 2];
                    let h_idx = history.len();
                    history.push(HistoryStep {
                        node_id: edge.target_id,
                        from_node_id: curr.node_id,
                        ilon: edge.target_lon,
                        ilat: edge.target_lat,
                        selev: t_elev,
                        sub_points: poly,
                        dist: edge_dist,
                        time: edge_time,
                        energy: edge_energy,
                        cost: new_cost,
                        prev_idx: Some(curr.history_idx),
                        way_cost: Some(way_cost.clone()),
                    });

                    open_set.push(SearchNode {
                        node_id: edge.target_id,
                        from_node_id: curr.node_id,
                        ilon: edge.target_lon,
                        ilat: edge.target_lat,
                        selev: t_elev,
                        cost: new_cost,
                        air_dist,
                        priority,
                        path_state,
                        prev_lon: prev_pt.0,
                        prev_lat: prev_pt.1,
                        priority_classifier: way_cost.priorityclassifier,
                        last_classifier: new_classifier,
                        _last_initial_cost: new_initial_cost,
                        in_destination: new_destination,
                        can_leave_destination: can_leave,
                        history_idx: h_idx,
                    });
                }
            }
        }

        let Some(target_h_idx) = best_target_history else {
            return Err("No path found between waypoints".to_string());
        };

        // Reconstruct path
        let mut steps = Vec::new();
        let mut curr_idx = Some(target_h_idx);
        while let Some(idx) = curr_idx {
            steps.push(&history[idx]);
            curr_idx = history[idx].prev_idx;
        }
        steps.reverse();

        let mut route_points: Vec<RoutePoint> = Vec::new();
        let mut cum_dist = 0.0;
        let mut cum_time = 0.0;
        let mut cum_energy = 0.0;

        let mut ele_start = 0.0;
        let mut ele_end = 0.0;
        let mut filtered_ascend = 0.0;
        let mut ehb = 0.0;
        let mut last_selev = i16::MIN;
        let mut last_pt_pos: Option<(i32, i32)> = None;

        let mut detail_state = PathState::default();

        for (s_i, step) in steps.iter().enumerate() {
            for (p_i, pt) in step.sub_points.iter().enumerate() {
                if p_i == 0 && s_i > 0 {
                    continue; // skip duplicate edge junction
                }
                let lon = ilon_to_lon(pt.0);
                let lat = ilat_to_lat(pt.1);
                let elev = selev_to_elevation(pt.2);
                if route_points.is_empty() {
                    ele_start = elev;
                }
                ele_end = elev;

                if let Some(last_pos) = last_pt_pos {
                    let seg_d = (distance(
                        last_pos.0,
                        last_pos.1,
                        pt.0,
                        pt.1,
                    ).round() as f64).max(1.0);
                    cum_dist += seg_d;

                    // Filtered ascend calculation matching BRouter (1-arcsec SRTM filter: -5.0m)
                    let dh = if pt.2 == i16::MIN || last_selev == i16::MIN {
                        0.0
                    } else {
                        elev - selev_to_elevation(last_selev)
                    };
                    ehb += dh;
                    if ehb > 0.0 {
                        filtered_ascend += ehb;
                        ehb = 0.0;
                    } else if ehb < -5.0 {
                        ehb = -5.0;
                    }

                    if let Some(ref wc) = step.way_cost {
                        let incline = StdPathCalculator::calc_incline(&mut detail_state.elevation_buffer, dh, seg_d);
                        let (speed, energy) = self.kinematic_cfg.compute_speed_and_energy(
                            seg_d,
                            incline,
                            wc.maxspeed as f64 / 3.6,
                        );
                        let dt = seg_d / speed;
                        cum_time += dt;
                        cum_energy += energy;
                    }
                }
                last_pt_pos = Some((pt.0, pt.1));
                last_selev = pt.2;

                route_points.push(RoutePoint {
                    lon,
                    lat,
                    elevation_m: elev,
                    distance_from_start_m: cum_dist,
                    time_from_start_s: cum_time,
                    energy_j: cum_energy,
                    cost: step.cost,
                });
            }
        }

        let plain_ascend = ele_end - ele_start;
        println!("        [STATS] popped: {}, edges: {}", nodes_popped, edges_evaluated);

        let route_links: Vec<(u64, u64, u32)> = steps
            .iter()
            .map(|s| (s.from_node_id, s.node_id, s.cost))
            .collect();

        Ok((
            RouteResult {
                total_distance_m: cum_dist,
                total_time_s: cum_time,
                total_energy_j: cum_energy,
                total_cost: final_cost,
                filtered_ascend_m: filtered_ascend,
                plain_ascend_m: plain_ascend,
                points: route_points,
            },
            route_links,
        ))
    }
}

/// Projects `(cross_lon, cross_lat)` onto `poly`, returning `(segment_index, projected_point, cumulative_distance_to_projection)`.
fn find_crosspoint_projection(
    poly: &[(i32, i32, i16)],
    cross_lon: i32,
    cross_lat: i32,
) -> (usize, (i32, i32, i16), f64) {
    if poly.len() <= 1 {
        let pt = poly
            .first()
            .copied()
            .unwrap_or((cross_lon, cross_lat, i16::MIN));
        return (0, pt, 0.0);
    }

    let mut best_idx = 0;
    let mut min_dist_sq = f64::MAX;
    let mut best_elev = poly[0].2;
    let mut best_frac = 0.0;

    for i in 0..poly.len() - 1 {
        let p1 = &poly[i];
        let p2 = &poly[i + 1];

        let scales = spatial::get_lon_lat_to_meter_scales((p1.1 + p2.1) >> 1);
        let dlon2m = scales[0];
        let dlat2m = scales[1];

        let dx = (p2.0 - p1.0) as f64 * dlon2m;
        let dy = (p2.1 - p1.1) as f64 * dlat2m;
        let d_sq = dx * dx + dy * dy;

        let (dist_sq, frac) = if d_sq <= 1e-6 {
            let px = (cross_lon - p1.0) as f64 * dlon2m;
            let py = (cross_lat - p1.1) as f64 * dlat2m;
            (px * px + py * py, 0.0)
        } else {
            let px1 = (cross_lon - p1.0) as f64 * dlon2m;
            let py1 = (cross_lat - p1.1) as f64 * dlat2m;
            let t = ((px1 * dx + py1 * dy) / d_sq).clamp(0.0, 1.0);
            let proj_x = t * dx;
            let proj_y = t * dy;
            let diff_x = px1 - proj_x;
            let diff_y = py1 - proj_y;
            (diff_x * diff_x + diff_y * diff_y, t)
        };

        if dist_sq < min_dist_sq {
            min_dist_sq = dist_sq;
            best_idx = i;
            best_frac = frac;
            best_elev = if p1.2 != i16::MIN && p2.2 != i16::MIN {
                (p1.2 as f64 * (1.0 - frac) + p2.2 as f64 * frac).round() as i16
            } else if p1.2 != i16::MIN {
                p1.2
            } else {
                p2.2
            };
        }
    }

    let mut cum_dist = 0.0;
    for i in 0..best_idx {
        cum_dist += distance(poly[i].0, poly[i].1, poly[i + 1].0, poly[i + 1].1);
    }
    let seg_len = distance(
        poly[best_idx].0,
        poly[best_idx].1,
        poly[best_idx + 1].0,
        poly[best_idx + 1].1,
    );
    cum_dist += seg_len * best_frac;

    (best_idx, (cross_lon, cross_lat, best_elev), cum_dist)
}

/// Slices an edge polyline starting from `crosspoint` to the end.
fn slice_from_crosspoint(
    poly: &[(i32, i32, i16)],
    cross_lon: i32,
    cross_lat: i32,
) -> Vec<(i32, i32, i16)> {
    let (idx, cross_pt, _) = find_crosspoint_projection(poly, cross_lon, cross_lat);
    let mut sliced = Vec::with_capacity(poly.len() - idx + 1);
    sliced.push(cross_pt);
    for pt in &poly[idx + 1..] {
        if pt.0 != cross_pt.0 || pt.1 != cross_pt.1 {
            sliced.push(*pt);
        }
    }
    if sliced.len() == 1 && poly.len() >= 2 {
        sliced.push(poly[poly.len() - 1]);
    }
    sliced
}

/// Slices an edge polyline starting from beginning up to `crosspoint`.
fn slice_to_crosspoint(
    poly: &[(i32, i32, i16)],
    cross_lon: i32,
    cross_lat: i32,
) -> Vec<(i32, i32, i16)> {
    let (idx, cross_pt, _) = find_crosspoint_projection(poly, cross_lon, cross_lat);
    let mut sliced = Vec::with_capacity(idx + 2);
    for pt in &poly[..=idx] {
        if pt.0 != cross_pt.0 || pt.1 != cross_pt.1 {
            sliced.push(*pt);
        }
    }
    if sliced.is_empty()
        || sliced.last().unwrap().0 != cross_pt.0
        || sliced.last().unwrap().1 != cross_pt.1
    {
        sliced.push(cross_pt);
    }
    if sliced.len() == 1 && poly.len() >= 2 {
        sliced.insert(0, poly[0]);
    }
    sliced
}

/// Slices an edge polyline between two crosspoints on the same segment.
fn slice_between_crosspoints(
    poly: &[(i32, i32, i16)],
    start_lon: i32,
    start_lat: i32,
    target_lon: i32,
    target_lat: i32,
) -> Option<Vec<(i32, i32, i16)>> {
    let (s_idx, s_pt, s_dist) = find_crosspoint_projection(poly, start_lon, start_lat);
    let (t_idx, t_pt, t_dist) = find_crosspoint_projection(poly, target_lon, target_lat);

    if s_dist > t_dist {
        return None;
    }

    let mut sliced = vec![s_pt];
    if s_idx < t_idx {
        for pt in &poly[s_idx + 1..=t_idx] {
            if pt.0 != s_pt.0 || pt.1 != s_pt.1 {
                sliced.push(*pt);
            }
        }
    }
    if t_pt.0 != sliced.last().unwrap().0 || t_pt.1 != sliced.last().unwrap().1 {
        sliced.push(t_pt);
    }
    Some(sliced)
}

/// Evaluates cost, distance, time, and kinematics along a polyline.
fn process_polyline(
    poly: &[(i32, i32, i16)],
    path_state: &mut PathState,
    way_cost: &crate::dsl::evaluator::WayCostResult,
    elev_cfg: &ElevationConfig,
    kinematic_cfg: &KinematicConfig,
    crossing_cfg: &CrossingConfig,
    crossing_class: Option<u8>,
    old_prio: i32,
    prev_lon: i32,
    prev_lat: i32,
    is_start: bool,
    is_detail: bool,
) -> (u32, f64, f64, f64, i32, i32) {
    let mut edge_cost = 0u32;
    let mut edge_dist = 0.0f64;
    let mut edge_time = 0.0f64;
    let mut edge_energy = 0.0f64;

    let mut p_lon_prev = prev_lon;
    let mut p_lat_prev = prev_lat;

    for i in 0..poly.len() - 1 {
        let p1 = &poly[i];
        let p2 = &poly[i + 1];

        let seg_dist = distance(p1.0, p1.1, p2.0, p2.1);
        if seg_dist <= 0.0 {
            continue;
        }

        let delta_h = if p1.2 == i16::MIN || p2.2 == i16::MIN {
            0.0
        } else {
            (p2.2 - p1.2) as f64 * 0.25
        };

        let (angle, cos_angle) = if i == 0 && is_start {
            (0.0, 1.0)
        } else {
            calc_angle(p_lon_prev, p_lat_prev, p1.0, p1.1, p2.0, p2.1)
        };

        let crossing_penalty =
            if i == 0 && !is_start && crossing_cfg.consider_crossing && old_prio > 0 {
                if old_prio >= crossing_cfg.crossing_prio_h
                    && way_cost.priorityclassifier <= crossing_cfg.crossing_prio_l
                {
                    if let Some(cls) = crossing_class {
                        if cls >= 1 && cls <= 6 {
                            let idx = (cls - 1) as usize;
                            if angle < 0.0 {
                                crossing_cfg.cost_to_left[idx]
                            } else if angle > 0.0 {
                                crossing_cfg.cost_to_right[idx]
                            } else {
                                0
                            }
                        } else {
                            0
                        }
                    } else {
                        0
                    }
                } else {
                    0
                }
            } else {
                0
            };

        let sec = StdPathCalculator::process_section(
            path_state,
            way_cost,
            elev_cfg,
            kinematic_cfg,
            seg_dist,
            delta_h,
            cos_angle,
            crossing_penalty,
            is_detail,
        );

        edge_cost += sec.section_cost_int;
        edge_dist += seg_dist;
        edge_time += sec.time_seconds;
        edge_energy += sec.energy_joules;

        p_lon_prev = p1.0;
        p_lat_prev = p1.1;
    }

    let penultimate_lon = if poly.len() >= 2 {
        poly[poly.len() - 2].0
    } else {
        prev_lon
    };
    let penultimate_lat = if poly.len() >= 2 {
        poly[poly.len() - 2].1
    } else {
        prev_lat
    };

    (
        edge_cost,
        edge_dist,
        edge_time,
        edge_energy,
        penultimate_lon,
        penultimate_lat,
    )
}
