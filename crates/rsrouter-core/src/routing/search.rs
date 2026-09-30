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



use std::collections::HashSet;

use super::cost::KinematicConfig;
use super::path::{CrossingConfig, ElevationConfig, PathState, SectionInput, StdPathCalculator};
use super::slicing::{slice_between_crosspoints, slice_from_crosspoint, slice_to_crosspoint};
use super::state::{
    CandidateState, EdgeState, FastHashMap, HeapItem, HistoryStep, NodePool,
    Pass0CostGuide, QuadHeap, SearchNode, SearchTrack, TrackStep,
};
use crate::dsl::evaluator::ProfileEvaluator;
use crate::dsl::lookups::LookupData;
use crate::dsl::parser::Profile;
use crate::graph::matcher::MatchedWaypoint;
use crate::graph::routing_graph::{GraphEdge, RoutingGraph, NO_DESC};
use crate::graph::spatial::{
    self, calc_angle, distance, ilat_to_lat, ilon_to_lon, selev_to_elevation,
};
use crate::rd5::micro_cache::DecodedTurnRestriction;
use crate::types::{Cost, Distance, Joules, NodeId, Point2D, Point3D, Seconds};

/// A single coordinate point along the computed route.
#[derive(Debug, Clone)]
pub struct RoutePoint {
    pub lon: f64,
    pub lat: f64,
    pub elevation_m: f64,
    pub distance_from_start_m: Distance,
    pub time_from_start_s: Seconds,
    pub energy_j: Joules,
    pub cost: Cost,
}

/// The final computed route with full metrics.
#[derive(Debug, Clone)]
pub struct RouteResult {
    pub total_distance_m: Distance,
    pub total_time_s: Seconds,
    pub total_energy_j: Joules,
    pub total_cost: Cost,
    pub filtered_ascend_m: Distance,
    pub plain_ascend_m: Distance,
    pub points: Vec<RoutePoint>,
}

impl RouteResult {
    /// Merges multiple sequential route legs into a single continuous route.
    pub fn merge(legs: Vec<RouteResult>) -> Result<Self, String> {
        if legs.is_empty() {
            return Err("Cannot merge empty route legs".to_string());
        }
        let mut iter = legs.into_iter();
        let mut merged = iter.next().unwrap();
        for leg in iter {
            merged.append(leg);
        }
        Ok(merged)
    }

    /// Appends the next route leg, offsetting cumulative metrics and deduplicating the junction coordinate.
    pub fn append(&mut self, next: RouteResult) {
        let dist_offset = self.total_distance_m;
        let time_offset = self.total_time_s;
        let energy_offset = self.total_energy_j;
        let cost_offset = self.total_cost;

        // Deduplicate junction point if within 1e-5 degrees (~1 meter)
        let skip_count = if let (Some(last), Some(first)) = (self.points.last(), next.points.first()) {
            if (last.lon - first.lon).abs() < 1e-5 && (last.lat - first.lat).abs() < 1e-5 {
                1
            } else {
                0
            }
        } else {
            0
        };

        for pt in next.points.into_iter().skip(skip_count) {
            self.points.push(RoutePoint {
                lon: pt.lon,
                lat: pt.lat,
                elevation_m: pt.elevation_m,
                distance_from_start_m: pt.distance_from_start_m + dist_offset,
                time_from_start_s: pt.time_from_start_s + time_offset,
                energy_j: pt.energy_j + energy_offset,
                cost: pt.cost + cost_offset,
            });
        }

        self.total_distance_m += next.total_distance_m;
        self.total_time_s += next.total_time_s;
        self.total_energy_j += next.total_energy_j;
        self.total_cost += next.total_cost;
        self.plain_ascend_m += next.plain_ascend_m;
        self.filtered_ascend_m += next.filtered_ascend_m;
    }

    /// Formats the route as a BRouter-compatible GeoJSON FeatureCollection.
    pub fn to_geojson(&self, profile_name: &str) -> String {
        let mut coords = String::new();
        for (i, pt) in self.points.iter().enumerate() {
            if i > 0 {
                coords.push_str(",\n          ");
            }
            coords.push_str(&format!(
                "[{:.6}, {:.6}, {}]",
                pt.lon, pt.lat, pt.elevation_m
            ));
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

/// A* router engine implementing 2-pass guided search.
#[derive(Default)]
pub struct AStarRouter {
    pub kinematic_cfg: KinematicConfig,
    pub elev_cfg: ElevationConfig,
}

pub type CostCuttingGuide<'a> = &'a Pass0CostGuide;

/// Configuration bundle for edge cost and physics evaluation.
#[derive(Clone, Copy)]
pub struct RoutingConfigs<'a> {
    pub elev: &'a ElevationConfig,
    pub kinematic: &'a KinematicConfig,
    pub crossing: &'a CrossingConfig,
}

/// Context of the preceding path step when entering an edge.
#[derive(Clone, Copy, Debug)]
pub struct EdgeContext {
    pub crossing_class: Option<u8>,
    pub old_prio: i32,
    pub prev_point: Point2D,
    pub is_start: bool,
    pub is_detail: bool,
}

/// Global graph, lookup tables, and profile context for search passes.
pub struct EngineContext<'a> {
    pub graph: &'a RoutingGraph,
    pub lookups: &'a LookupData,
    pub profile: &'a Profile,
    pub cached_way_costs: &'a [crate::dsl::evaluator::WayCostResult],
}

/// Kinematic and elevation configuration bundle for a search pass.
#[derive(Clone, Copy)]
pub struct PassConfigs<'a> {
    pub kinematic: &'a KinematicConfig,
    pub elev: &'a ElevationConfig,
}

/// Waypoint and heuristics parameters for a search pass.
pub struct SearchPassParams<'a> {
    pub start_mwp: &'a MatchedWaypoint,
    pub target_mwp: &'a MatchedWaypoint,
    pub air_distance_factor: f64,
    pub cost_cutting: Option<CostCuttingGuide<'a>>,
    pub ref_nodes: Option<&'a HashSet<NodeId>>,
}

/// Resource and termination bounds for a search pass.
#[derive(Clone, Copy, Debug)]
pub struct SearchLimits {
    pub max_cost: Option<Cost>,
    pub edge_cap: usize,
    pub heap_cap: usize,
}

/// Retrieves pre-evaluated way costs for a given description ID and direction.
///
/// Layout in `cached_way_costs`:
/// Each unique `desc_id` occupies two consecutive slots:
/// - Even index `(desc_id << 1)`: forward traversal (`is_reverse == false`).
/// - Odd index `(desc_id << 1) | 1`: reverse traversal (`is_reverse == true`, with `way_buf[0] = 2`).
#[inline(always)]
fn get_way_cost(
    cached_way_costs: &[crate::dsl::evaluator::WayCostResult],
    desc_id: u32,
    is_reverse: bool,
) -> Option<&crate::dsl::evaluator::WayCostResult> {
    if desc_id == NO_DESC {
        None
    } else {
        let idx = ((desc_id as usize) << 1) | (is_reverse as usize);
        cached_way_costs.get(idx)
    }
}

impl AStarRouter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Computes a continuous route passing sequentially through multiple waypoints.
    pub fn find_multi_route(
        &self,
        graph: &RoutingGraph,
        lookups: &LookupData,
        profile: &Profile,
        waypoints: &[(f64, f64)],
    ) -> Result<RouteResult, String> {
        self.find_multi_route_with_alternative(graph, lookups, profile, waypoints, 0)
    }

    /// Computes a continuous route passing sequentially through multiple waypoints with an alternative route index (0..=3).
    pub fn find_multi_route_with_alternative(
        &self,
        graph: &RoutingGraph,
        lookups: &LookupData,
        profile: &Profile,
        waypoints: &[(f64, f64)],
        alternative_idx: usize,
    ) -> Result<RouteResult, String> {
        if waypoints.len() < 2 {
            return Err("At least two waypoints required for routing".to_string());
        }
        let mut legs = Vec::with_capacity(waypoints.len() - 1);
        for i in 0..waypoints.len() - 1 {
            let leg = self.find_route_with_alternative(
                graph,
                lookups,
                profile,
                waypoints[i],
                waypoints[i + 1],
                alternative_idx,
            )?;
            legs.push(leg);
        }
        RouteResult::merge(legs)
    }

    /// Computes a complete route between `start` and `target` waypoints.
    pub fn find_route(
        &self,
        graph: &RoutingGraph,
        lookups: &LookupData,
        profile: &Profile,
        start: (f64, f64),
        target: (f64, f64),
    ) -> Result<RouteResult, String> {
        self.find_route_with_alternative(graph, lookups, profile, start, target, 0)
    }

    /// Computes a complete route between `start` and `target` waypoints with an alternative route index (0..=3).
    pub fn find_route_with_alternative(
        &self,
        graph: &RoutingGraph,
        lookups: &LookupData,
        profile: &Profile,
        start: (f64, f64),
        target: (f64, f64),
        alternative_idx: usize,
    ) -> Result<RouteResult, String> {
        let (start_lon, start_lat) = start;
        let (target_lon, target_lat) = target;
        let mut evaluator = ProfileEvaluator::new(profile, &lookups.way, &lookups.node);

        // 1. Snap waypoints
        let start_mwp = graph
            .snap_waypoint("from", start_lon, start_lat, 200.0, &mut evaluator, lookups)
            .ok_or_else(|| "Start position could not be mapped to graph".to_string())?;

        let target_mwp = graph
            .snap_waypoint("to", target_lon, target_lat, 200.0, &mut evaluator, lookups)
            .ok_or_else(|| "Target position could not be mapped to graph".to_string())?;

        let kinematic_cfg = KinematicConfig::from_profile(profile);
        let elev_cfg = ElevationConfig::from_profile(profile);

        let pass1_coeff = profile.get_global_var("pass1coefficient", 1.5) as f64;
        let pass2_coeff = profile.get_global_var("pass2coefficient", 0.0) as f64;

        let cached_way_costs = graph.preload_profile_costs(profile, lookups);

        let air_dist_km = distance(start_mwp.crosspoint, target_mwp.crosspoint) / 1000.0;
        let edge_cap = if air_dist_km < 25.0 {
            131_072
        } else if air_dist_km < 100.0 {
            1_048_576
        } else {
            (graph.edge_count() / 2).clamp(1_048_576, 4_194_304)
        };
        let heap_cap = (edge_cap / 8).clamp(32_768, 262_144);

        let pass_configs = PassConfigs {
            kinematic: &kinematic_cfg,
            elev: &elev_cfg,
        };
        let engine = EngineContext {
            graph,
            lookups,
            profile,
            cached_way_costs: &cached_way_costs,
        };

        let mut ref_nodes: HashSet<NodeId> = HashSet::new();
        let mut target_result = None;

        for alt in 0..=alternative_idx {
            let ref_param = if alt > 0 { Some(&ref_nodes) } else { None };

            // 2. Run Pass 0 (fast initial search with pass1coefficient)
            let pass0_params = SearchPassParams {
                start_mwp: &start_mwp,
                target_mwp: &target_mwp,
                air_distance_factor: pass1_coeff,
                cost_cutting: None,
                ref_nodes: ref_param,
            };
            let pass0_limits = SearchLimits {
                max_cost: None,
                edge_cap,
                heap_cap,
            };
            let pass0_track = self.search_pass(
                &engine,
                &pass_configs,
                &pass0_params,
                &pass0_limits,
            )?;

            let winning_track = if pass2_coeff >= 0.0 {
                let mut cost_guide = Pass0CostGuide::new(pass0_track.steps.len(), pass0_track.total_cost);
                for step in &pass0_track.steps {
                    cost_guide.record_edge(step.global_edge_idx, step.cost);
                }

                let cost_cutting_threshold = Some(pass0_track.total_cost + 5000);

                let pass1_params = SearchPassParams {
                    start_mwp: &start_mwp,
                    target_mwp: &target_mwp,
                    air_distance_factor: pass2_coeff,
                    cost_cutting: Some(&cost_guide),
                    ref_nodes: ref_param,
                };
                let pass1_limits = SearchLimits {
                    max_cost: cost_cutting_threshold,
                    edge_cap,
                    heap_cap,
                };
                let pass1_res = self.search_pass(
                    &engine,
                    &pass_configs,
                    &pass1_params,
                    &pass1_limits,
                );

                match pass1_res {
                    Ok(pass1_track) => {
                        if pass1_track.total_cost <= pass0_track.total_cost {
                            pass1_track
                        } else {
                            pass0_track
                        }
                    }
                    Err(_) => pass0_track,
                }
            } else {
                pass0_track
            };

            // 3. Run Pass 2 (re-tracking): walk the winning path, decode geometry, evaluate kinematics
            let route = self.retrack_path(
                graph,
                &winning_track.steps,
                winning_track.total_cost,
                &kinematic_cfg,
            )?;

            if alt < alternative_idx {
                for step in &winning_track.steps {
                    if step.from_node_id != 0 {
                        ref_nodes.insert(step.from_node_id);
                    }
                    if step.node_id != 0 {
                        ref_nodes.insert(step.node_id);
                    }
                }
                for pt in &route.points {
                    let id = Point2D::new(spatial::lon_to_ilon(pt.lon), spatial::lat_to_ilat(pt.lat)).node_id();
                    ref_nodes.insert(id);
                }
            }

            if alt == alternative_idx {
                target_result = Some(route);
                break;
            }
        }

        target_result.ok_or_else(|| "Failed to calculate route".to_string())
    }

    fn search_pass(
        &self,
        engine: &EngineContext,
        configs: &PassConfigs,
        params: &SearchPassParams,
        limits: &SearchLimits,
    ) -> Result<SearchTrack, String> {
        let ctx = SearchPassContext::new(
            engine,
            configs,
            params,
        );

        let mut state = SearchPassState::new(
            &ctx,
            engine.profile,
            limits.max_cost,
            engine.graph.total_edges,
            limits.edge_cap,
            limits.heap_cap,
        );
        state.seed_pass(&ctx)?;
        state.run_search(&ctx)?;
        state.reconstruct_track(&ctx)
    }

    fn retrack_path(
        &self,
        graph: &RoutingGraph,
        steps: &[TrackStep],
        final_cost: u32,
        kinematic_cfg: &KinematicConfig,
    ) -> Result<RouteResult, String> {
        let mut route_points: Vec<RoutePoint> = Vec::new();
        let mut cum_dist = 0.0;
        let mut cum_time = 0.0f32;
        let mut cum_energy = 0.0f32;

        let mut ele_start = 0.0;
        let mut ele_end = 0.0;
        let mut filtered_ascend = 0.0;
        let mut ehb = 0.0;
        let mut last_selev = i16::MIN;
        let mut last_pt_pos: Option<Point2D> = None;

        let mut detail_state = PathState::default();

        for (s_i, step) in steps.iter().enumerate() {
            let poly = if let Some(ref sliced) = step.sliced_points {
                sliced.clone()
            } else {
                let from_node = graph.nodes.get(&step.from_node_id).ok_or_else(|| {
                    format!(
                        "From node {} not found in graph during retrack",
                        step.from_node_id
                    )
                })?;
                let to_node = graph.nodes.get(&step.node_id).ok_or_else(|| {
                    format!(
                        "Target node {} not found in graph during retrack",
                        step.node_id
                    )
                })?;
                let edges = graph.get_edges(step.from_node_id);
                if edges.is_empty() {
                    return Err(format!(
                        "Outgoing edges for node {} not found during retrack",
                        step.from_node_id
                    ));
                }
                let edge = if (step.edge_idx as usize) < edges.len()
                    && edges[step.edge_idx as usize].target_id == step.node_id
                {
                    &edges[step.edge_idx as usize]
                } else {
                    edges
                        .iter()
                        .find(|e| e.target_id == step.node_id)
                        .ok_or_else(|| {
                            format!(
                                "Edge from {} to {} not found during retrack",
                                step.from_node_id, step.node_id
                            )
                        })?
                };
                edge.polyline(
                    from_node.ilon,
                    from_node.ilat,
                    from_node.selev,
                    to_node.selev,
                )
            };

            for (p_i, pt) in poly.iter().enumerate() {
                if p_i == 0 && s_i > 0 {
                    continue; // skip duplicate edge junction
                }
                let lon = ilon_to_lon(pt.lon);
                let lat = ilat_to_lat(pt.lat);
                let elev = selev_to_elevation(pt.elev);
                if route_points.is_empty() {
                    ele_start = elev;
                }
                ele_end = elev;

                if let Some(last_pos) = last_pt_pos {
                    let seg_d = distance(last_pos, pt.to_2d())
                        .round()
                        .max(1.0);
                    cum_dist += seg_d;

                    // Filtered ascend calculation matching BRouter (-5.0m for 1-arcsec, -10.0m for 3-arcsec)
                    let dh = if pt.elev == i16::MIN || last_selev == i16::MIN {
                        0.0
                    } else {
                        elev - selev_to_elevation(last_selev)
                    };
                    ehb += dh;
                    let filter = graph.elevation_filter(pt.lon, pt.lat);
                    if ehb > 0.0 {
                        filtered_ascend += ehb;
                        ehb = 0.0;
                    } else if ehb < filter {
                        ehb = filter;
                    }

                    let incline = StdPathCalculator::calc_incline(
                        &mut detail_state.elevation_buffer,
                        dh,
                        seg_d,
                    );
                    let (speed, energy) = kinematic_cfg.compute_speed_and_energy(
                        seg_d,
                        incline,
                        step.maxspeed as f64 / 3.6,
                    );
                    let dt = (seg_d / speed) as f32;
                    cum_time += dt;
                    if energy > 0.0 {
                        cum_energy = (cum_energy as f64 + energy) as f32;
                    }
                }
                last_pt_pos = Some(pt.to_2d());
                last_selev = pt.elev;

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

        Ok(RouteResult {
            total_distance_m: cum_dist,
            total_time_s: cum_time,
            total_energy_j: cum_energy,
            total_cost: final_cost,
            filtered_ascend_m: filtered_ascend,
            plain_ascend_m: plain_ascend,
            points: route_points,
        })
    }
}

/// Immutable configuration and references for a single A* search pass.
struct SearchPassContext<'a> {
    graph: &'a RoutingGraph,
    lookups: &'a LookupData,
    cached_way_costs: &'a [crate::dsl::evaluator::WayCostResult],
    start_mwp: &'a MatchedWaypoint,
    target_mwp: &'a MatchedWaypoint,
    start_id1: NodeId,
    start_id2: NodeId,
    target_id1: NodeId,
    target_id2: NodeId,
    air_distance_factor: f64,
    kinematic_cfg: &'a KinematicConfig,
    elev_cfg: &'a ElevationConfig,
    crossing_cfg: CrossingConfig,
    crossing_tag_idx: Option<usize>,
    consider_tr: bool,
    is_bike_mode: bool,
    is_car_mode: bool,
    cost_cutting: Option<CostCuttingGuide<'a>>,
    ref_nodes: Option<&'a HashSet<NodeId>>,
    protected_nodes: Vec<NodeId>,
}

impl<'a> SearchPassContext<'a> {
    #[inline(always)]
    fn routing_configs(&self) -> RoutingConfigs<'_> {
        RoutingConfigs {
            elev: self.elev_cfg,
            kinematic: self.kinematic_cfg,
            crossing: &self.crossing_cfg,
        }
    }

    fn new(
        engine: &EngineContext<'a>,
        configs: &PassConfigs<'a>,
        params: &SearchPassParams<'a>,
    ) -> Self {
        let start_id1 = params.start_mwp.node1.node_id();
        let start_id2 = params.start_mwp.node2.node_id();
        let target_id1 = params.target_mwp.node1.node_id();
        let target_id2 = params.target_mwp.node2.node_id();

        let crossing_cfg = CrossingConfig::from_profile(engine.profile);
        let crossing_tag_idx = engine.lookups.node.get_name_idx("estimated_crossing_class");
        let consider_tr = engine.profile.get_global_var("considerTurnRestrictions", 0.0) != 0.0;
        let is_car_mode = engine.profile.name.starts_with("car");
        let is_bike_mode = !is_car_mode;

        let mut protected_nodes: Vec<u64> = Vec::with_capacity(16);
        for mut id in [target_id1, target_id2, start_id1, start_id2] {
            while let Some(&p) = engine.graph.dead_end_parents.get(&id) {
                if p == 0 || protected_nodes.contains(&id) {
                    break;
                }
                protected_nodes.push(id);
                id = p;
            }
        }

        Self {
            graph: engine.graph,
            lookups: engine.lookups,
            cached_way_costs: engine.cached_way_costs,
            start_mwp: params.start_mwp,
            target_mwp: params.target_mwp,
            start_id1,
            start_id2,
            target_id1,
            target_id2,
            air_distance_factor: params.air_distance_factor,
            kinematic_cfg: configs.kinematic,
            elev_cfg: configs.elev,
            crossing_cfg,
            crossing_tag_idx,
            consider_tr,
            is_bike_mode,
            is_car_mode,
            cost_cutting: params.cost_cutting,
            ref_nodes: params.ref_nodes,
            protected_nodes,
        }
    }
}

/// Mutable search state for a single A* search pass.
struct SearchPassState<'a> {
    evaluator: ProfileEvaluator<'a>,
    open_set: QuadHeap,
    node_pool: NodePool,
    edge_heads: Vec<u32>,
    closed_edges: Vec<u64>,
    edge_states_pool: Vec<EdgeState>,
    history: Vec<HistoryStep>,
    sliced_map: FastHashMap<u32, Vec<Point3D>>,
    poly_buf: Vec<Point3D>,
    node_lookup_buf: Vec<i32>,
    way_lookup_buf: Vec<i32>,
    max_cost_limit: Option<u32>,
    final_cost: u32,
    best_target_history: Option<u32>,
    nodes_popped: usize,
    edges_evaluated: usize,
}

impl<'a> SearchPassState<'a> {
    fn new(
        ctx: &SearchPassContext<'a>,
        profile: &'a Profile,
        max_cost_limit: Option<u32>,
        total_edges: usize,
        edge_cap: usize,
        heap_cap: usize,
    ) -> Self {
        let num_edge_words = total_edges.div_ceil(64);
        Self {
            evaluator: ProfileEvaluator::new(profile, &ctx.lookups.way, &ctx.lookups.node),
            open_set: QuadHeap::with_capacity(heap_cap),
            node_pool: NodePool::with_capacity(heap_cap),
            edge_heads: vec![u32::MAX; total_edges],
            closed_edges: vec![0u64; num_edge_words],
            edge_states_pool: Vec::with_capacity(edge_cap),
            history: Vec::with_capacity(edge_cap),
            sliced_map: FastHashMap::default(),
            poly_buf: Vec::with_capacity(64),
            node_lookup_buf: vec![0i32; ctx.lookups.node.names.len()],
            way_lookup_buf: vec![0i32; ctx.lookups.way.names.len()],
            max_cost_limit,
            final_cost: u32::MAX,
            best_target_history: None,
            nodes_popped: 0,
            edges_evaluated: 0,
        }
    }

    #[inline(always)]
    fn is_edge_closed(&self, edge_idx: u32) -> bool {
        let idx = edge_idx as usize;
        (self.closed_edges[idx >> 6] & (1u64 << (idx & 63))) != 0
    }

    #[inline(always)]
    fn mark_edge_closed(&mut self, edge_idx: u32) {
        let idx = edge_idx as usize;
        self.closed_edges[idx >> 6] |= 1u64 << (idx & 63);
    }

    #[inline(always)]
    fn get_edge_state(&self, edge_idx: u32) -> Option<&EdgeState> {
        let entry_idx = self.edge_heads[edge_idx as usize];
        if entry_idx != u32::MAX {
            Some(&self.edge_states_pool[entry_idx as usize])
        } else {
            None
        }
    }

    #[inline(always)]
    fn has_edge_state(&self, edge_idx: u32) -> bool {
        self.edge_heads[edge_idx as usize] != u32::MAX
    }

    #[inline(always)]
    fn get_or_create_edge_state(&mut self, edge_idx: u32) -> &mut EdgeState {
        let entry_idx = self.edge_heads[edge_idx as usize];
        if entry_idx != u32::MAX {
            &mut self.edge_states_pool[entry_idx as usize]
        } else {
            let new_idx = self.edge_states_pool.len() as u32;
            self.edge_states_pool.push(EdgeState::default());
            self.edge_heads[edge_idx as usize] = new_idx;
            &mut self.edge_states_pool[new_idx as usize]
        }
    }

    /// Seeds the search open set from start waypoint projections and checks same-segment shortcuts.
    fn seed_pass(&mut self, ctx: &SearchPassContext) -> Result<(), String> {
        // 1. Check if start and target are on the same segment
        let same_segment = (ctx.start_id1 == ctx.target_id1 && ctx.start_id2 == ctx.target_id2)
            || (ctx.start_id1 == ctx.target_id2 && ctx.start_id2 == ctx.target_id1);

        if same_segment {
            let edges = ctx.graph.get_edges(ctx.start_id1);
            for (edge_idx, edge) in edges.iter().enumerate() {
                if edge.target_id == ctx.start_id2 {
                    let Some(way_cost) =
                        get_way_cost(ctx.cached_way_costs, edge.desc_id, edge.is_reverse)
                    else {
                        continue;
                    };
                    if way_cost.costfactor >= 9999.0 {
                        continue;
                    }

                    let s_elev = ctx
                        .graph
                        .nodes
                        .get(&ctx.start_id1)
                        .map(|n| n.selev)
                        .unwrap_or(i16::MIN);
                    let t_elev = ctx
                        .graph
                        .nodes
                        .get(&ctx.start_id2)
                        .map(|n| n.selev)
                        .unwrap_or(i16::MIN);
                    let full_poly = edge.polyline(
                        ctx.start_mwp.node1.lon,
                        ctx.start_mwp.node1.lat,
                        s_elev,
                        t_elev,
                    );
                    if let Some(sliced) = slice_between_crosspoints(
                        &full_poly,
                        ctx.start_mwp.crosspoint,
                        ctx.target_mwp.crosspoint,
                    ) {
                        if sliced.len() >= 2 {
                            let mut path_state = PathState::default();
                            let edge_ctx = EdgeContext {
                                crossing_class: None,
                                old_prio: 0,
                                prev_point: sliced[0].to_2d(),
                                is_start: true,
                                is_detail: false,
                            };
                            let (cost, _, _, _, _) = process_polyline(
                                &sliced,
                                &mut path_state,
                                way_cost,
                                &ctx.routing_configs(),
                                &edge_ctx,
                            );
                            if cost < self.final_cost {
                                self.final_cost = cost;
                                let h_idx = self.history.len() as u32;
                                self.sliced_map.insert(h_idx, sliced.clone());
                                self.history.push(HistoryStep {
                                    node_id: 0,
                                    from_node_id: ctx.start_id1,
                                    cost,
                                    global_edge_idx: edge.edge_idx,
                                    edge_idx: edge_idx as u16,
                                    maxspeed: way_cost.maxspeed,
                                    prev_idx: u32::MAX,
                                });
                                let node_idx = self.node_pool.alloc(SearchNode {
                                    node_id: 0,
                                    from_node_id: ctx.start_id1,
                                    ilon: ctx.target_mwp.crosspoint.lon,
                                    ilat: ctx.target_mwp.crosspoint.lat,
                                    cost,
                                    air_dist: 0,
                                    priority: cost,
                                    path_state,
                                    prev_lon: sliced[0].lon,
                                    prev_lat: sliced[0].lat,
                                    priority_classifier: 0,
                                    down_div: 0,
                                    up_div: 0,
                                    history_idx: h_idx,
                                    selev: 0,
                                    last_classifier: 0,
                                    in_destination: false,
                                    can_leave_destination: false,
                                    edge_idx: edge.edge_idx,
                                    rev_edge_idx: edge.rev_edge_idx,
                                    out_edges_start: 0,
                                    out_edges_count: 0,
                                });
                                self.open_set.push(HeapItem {
                                    priority: cost,
                                    node_idx,
                                });
                                self.best_target_history = Some(h_idx);
                            }
                        }
                    }
                }
            }
        }

        // 2. Seed start search paths
        if ctx.start_id1 == ctx.start_id2 {
            if let Some(node) = ctx.graph.nodes.get(&ctx.start_id1) {
                let air_dist = distance(
                    Point2D::new(node.ilon, node.ilat),
                    ctx.target_mwp.crosspoint,
                );
                let priority = (air_dist * ctx.air_distance_factor) as u32;

                let h_idx = self.history.len() as u32;
                self.sliced_map
                    .insert(h_idx, vec![Point3D::new(node.ilon, node.ilat, node.selev)]);
                self.history.push(HistoryStep {
                    node_id: ctx.start_id1,
                    from_node_id: 0,
                    cost: 0,
                    global_edge_idx: u32::MAX,
                    edge_idx: 0,
                    maxspeed: 0.0,
                    prev_idx: u32::MAX,
                });

                let (out_start, out_count) = ctx.graph.get_node_edge_slice(ctx.start_id1);
                let node_idx = self.node_pool.alloc(SearchNode {
                    node_id: ctx.start_id1,
                    from_node_id: 0,
                    ilon: node.ilon,
                    ilat: node.ilat,
                    cost: 0,
                    air_dist: air_dist as u32,
                    priority,
                    path_state: PathState::default(),
                    prev_lon: node.ilon,
                    prev_lat: node.ilat,
                    priority_classifier: 0,
                    down_div: 0,
                    up_div: 0,
                    history_idx: h_idx,
                    selev: node.selev,
                    last_classifier: 0,
                    in_destination: false,
                    can_leave_destination: false,
                    edge_idx: u32::MAX,
                    rev_edge_idx: u32::MAX,
                    out_edges_start: out_start,
                    out_edges_count: out_count,
                });
                self.open_set.push(HeapItem { priority, node_idx });
            }
        } else {
            // Direction A: from start_crosspoint towards start_id2
            let edges = ctx.graph.get_edges(ctx.start_id1);
            for (edge_idx, edge) in edges.iter().enumerate() {
                if edge.target_id == ctx.start_id2 {
                    let Some(way_cost) =
                        get_way_cost(ctx.cached_way_costs, edge.desc_id, edge.is_reverse)
                    else {
                        continue;
                    };
                    if way_cost.costfactor >= 9999.0 {
                        continue;
                    }

                    let s_node = ctx.graph.nodes.get(&ctx.start_id1);
                    let t_node = ctx.graph.nodes.get(&ctx.start_id2);
                    let s_elev = s_node.map(|n| n.selev).unwrap_or(i16::MIN);
                    let t_elev = t_node.map(|n| n.selev).unwrap_or(i16::MIN);
                    let full_poly = edge.polyline(
                        ctx.start_mwp.node1.lon,
                        ctx.start_mwp.node1.lat,
                        s_elev,
                        t_elev,
                    );
                    let sliced = slice_from_crosspoint(
                        &full_poly,
                        ctx.start_mwp.crosspoint,
                    );
                    if sliced.len() >= 2 {
                        let mut path_state = PathState::default();
                        let edge_ctx = EdgeContext {
                            crossing_class: None,
                            old_prio: 0,
                            prev_point: sliced[0].to_2d(),
                            is_start: true,
                            is_detail: false,
                        };
                        let (cost, _, _, _, penultimate_pt) =
                            process_polyline(
                                &sliced,
                                &mut path_state,
                                way_cost,
                                &ctx.routing_configs(),
                                &edge_ctx,
                            );

                        let mut total_cost = cost;
                        if let Some(target_node) = t_node {
                            if let Some(ref node_desc) = target_node.node_description {
                                if let Some(desc_bytes) = edge.description(ctx.graph) {
                                    ctx.lookups.way.decode_into(
                                        &mut self.way_lookup_buf,
                                        edge.is_reverse,
                                        desc_bytes,
                                    );
                                    self.evaluator.evaluate_way(&self.way_lookup_buf);
                                }
                                ctx.lookups.node.decode_into(
                                    &mut self.node_lookup_buf,
                                    way_cost.nodeaccessgranted,
                                    node_desc,
                                );
                                let node_res =
                                    self.evaluator.evaluate_node(&self.node_lookup_buf);
                                if node_res.initialcost >= 1_000_000.0 {
                                    continue;
                                }
                                total_cost += node_res.initialcost as u32;
                            }
                        }

                        let air_dist = distance(
                            ctx.start_mwp.node2,
                            ctx.target_mwp.crosspoint,
                        );
                        let priority = total_cost + (air_dist * ctx.air_distance_factor) as u32;

                        let (down_div, up_div) = StdPathCalculator::cost_divisors(way_cost);
                        let h_idx = self.history.len() as u32;
                        self.sliced_map.insert(h_idx, sliced);
                        self.history.push(HistoryStep {
                            node_id: ctx.start_id2,
                            from_node_id: ctx.start_id1,
                            cost: total_cost,
                            global_edge_idx: edge.edge_idx,
                            edge_idx: edge_idx as u16,
                            maxspeed: way_cost.maxspeed,
                            prev_idx: u32::MAX,
                        });

                        self.get_or_create_edge_state(edge.edge_idx)
                            .push(CandidateState {
                                cost: total_cost,
                                ehbd: path_state.ehbd,
                                ehbu: path_state.ehbu,
                            });

                        let in_destination = (way_cost.classifiermask & 64) != 0;
                        let node_idx = self.node_pool.alloc(SearchNode {
                            node_id: ctx.start_id2,
                            from_node_id: ctx.start_id1,
                            ilon: ctx.start_mwp.node2.lon,
                            ilat: ctx.start_mwp.node2.lat,
                            cost: total_cost,
                            air_dist: air_dist as u32,
                            priority,
                            path_state,
                            prev_lon: penultimate_pt.lon,
                            prev_lat: penultimate_pt.lat,
                            priority_classifier: way_cost.priorityclassifier,
                            down_div,
                            up_div,
                            history_idx: h_idx,
                            selev: t_elev,
                            last_classifier: way_cost.initialclassifier,
                            in_destination,
                            can_leave_destination: in_destination,
                            edge_idx: edge.edge_idx,
                            rev_edge_idx: edge.rev_edge_idx,
                            out_edges_start: edge.target_edges_start,
                            out_edges_count: edge.target_edges_count,
                        });
                        self.open_set.push(HeapItem { priority, node_idx });
                    }
                }
            }
            // Direction B: from start_crosspoint towards start_id1
            let edges = ctx.graph.get_edges(ctx.start_id2);
            for (edge_idx, edge) in edges.iter().enumerate() {
                if edge.target_id == ctx.start_id1 {
                    let Some(way_cost) =
                        get_way_cost(ctx.cached_way_costs, edge.desc_id, edge.is_reverse)
                    else {
                        continue;
                    };
                    if way_cost.costfactor >= 9999.0 {
                        continue;
                    }

                    let s_node = ctx.graph.nodes.get(&ctx.start_id2);
                    let t_node = ctx.graph.nodes.get(&ctx.start_id1);
                    let s_elev = s_node.map(|n| n.selev).unwrap_or(i16::MIN);
                    let t_elev = t_node.map(|n| n.selev).unwrap_or(i16::MIN);
                    let full_poly = edge.polyline(
                        ctx.start_mwp.node2.lon,
                        ctx.start_mwp.node2.lat,
                        s_elev,
                        t_elev,
                    );
                    let sliced = slice_from_crosspoint(
                        &full_poly,
                        ctx.start_mwp.crosspoint,
                    );
                    if sliced.len() >= 2 {
                        let mut path_state = PathState::default();
                        let edge_ctx = EdgeContext {
                            crossing_class: None,
                            old_prio: 0,
                            prev_point: sliced[0].to_2d(),
                            is_start: true,
                            is_detail: false,
                        };
                        let (cost, _, _, _, penultimate_pt) =
                            process_polyline(
                                &sliced,
                                &mut path_state,
                                way_cost,
                                &ctx.routing_configs(),
                                &edge_ctx,
                            );

                        let mut total_cost = cost;
                        if let Some(target_node) = t_node {
                            if let Some(ref node_desc) = target_node.node_description {
                                if let Some(desc_bytes) = edge.description(ctx.graph) {
                                    ctx.lookups.way.decode_into(
                                        &mut self.way_lookup_buf,
                                        edge.is_reverse,
                                        desc_bytes,
                                    );
                                    self.evaluator.evaluate_way(&self.way_lookup_buf);
                                }
                                ctx.lookups.node.decode_into(
                                    &mut self.node_lookup_buf,
                                    way_cost.nodeaccessgranted,
                                    node_desc,
                                );
                                let node_res =
                                    self.evaluator.evaluate_node(&self.node_lookup_buf);
                                if node_res.initialcost >= 1_000_000.0 {
                                    continue;
                                }
                                total_cost += node_res.initialcost as u32;
                            }
                        }

                        let air_dist = distance(
                            ctx.start_mwp.node1,
                            ctx.target_mwp.crosspoint,
                        );
                        let priority = total_cost + (air_dist * ctx.air_distance_factor) as u32;

                        let (down_div, up_div) = StdPathCalculator::cost_divisors(way_cost);
                        let h_idx = self.history.len() as u32;
                        self.sliced_map.insert(h_idx, sliced);
                        self.history.push(HistoryStep {
                            node_id: ctx.start_id1,
                            from_node_id: ctx.start_id2,
                            cost: total_cost,
                            global_edge_idx: edge.edge_idx,
                            edge_idx: edge_idx as u16,
                            maxspeed: way_cost.maxspeed,
                            prev_idx: u32::MAX,
                        });

                        self.get_or_create_edge_state(edge.edge_idx)
                            .push(CandidateState {
                                cost: total_cost,
                                ehbd: path_state.ehbd,
                                ehbu: path_state.ehbu,
                            });

                        let in_destination = (way_cost.classifiermask & 64) != 0;
                        let node_idx = self.node_pool.alloc(SearchNode {
                            node_id: ctx.start_id1,
                            from_node_id: ctx.start_id2,
                            ilon: ctx.start_mwp.node1.lon,
                            ilat: ctx.start_mwp.node1.lat,
                            cost: total_cost,
                            air_dist: air_dist as u32,
                            priority,
                            path_state,
                            prev_lon: penultimate_pt.lon,
                            prev_lat: penultimate_pt.lat,
                            priority_classifier: way_cost.priorityclassifier,
                            down_div,
                            up_div,
                            history_idx: h_idx,
                            selev: t_elev,
                            last_classifier: way_cost.initialclassifier,
                            in_destination,
                            can_leave_destination: in_destination,
                            edge_idx: edge.edge_idx,
                            rev_edge_idx: edge.rev_edge_idx,
                            out_edges_start: edge.target_edges_start,
                            out_edges_count: edge.target_edges_count,
                        });
                        self.open_set.push(HeapItem { priority, node_idx });
                    }
                }
            }
        }

        // Fallback if neither partial edge was formed
        if self.open_set.is_empty() && self.final_cost == u32::MAX {
            for &s_id in &[ctx.start_id1, ctx.start_id2] {
                if let Some(node) = ctx.graph.nodes.get(&s_id) {
                    let air_dist = distance(
                        Point2D::new(node.ilon, node.ilat),
                        ctx.target_mwp.crosspoint,
                    );
                    let priority = (air_dist * ctx.air_distance_factor) as u32;

                    let h_idx = self.history.len() as u32;
                    self.sliced_map
                        .insert(h_idx, vec![Point3D::new(node.ilon, node.ilat, node.selev)]);
                    self.history.push(HistoryStep {
                        node_id: s_id,
                        from_node_id: 0,
                        cost: 0,
                        global_edge_idx: u32::MAX,
                        edge_idx: 0,
                        maxspeed: 0.0,
                        prev_idx: u32::MAX,
                    });

                    let (out_start, out_count) = ctx.graph.get_node_edge_slice(s_id);
                    let node_idx = self.node_pool.alloc(SearchNode {
                        node_id: s_id,
                        from_node_id: 0,
                        ilon: node.ilon,
                        ilat: node.ilat,
                        cost: 0,
                        air_dist: air_dist as u32,
                        priority,
                        path_state: PathState::default(),
                        prev_lon: node.ilon,
                        prev_lat: node.ilat,
                        priority_classifier: 0,
                        down_div: 0,
                        up_div: 0,
                        history_idx: h_idx,
                        selev: node.selev,
                        last_classifier: 0,
                        in_destination: false,
                        can_leave_destination: false,
                        edge_idx: u32::MAX,
                        rev_edge_idx: u32::MAX,
                        out_edges_start: out_start,
                        out_edges_count: out_count,
                    });
                    self.open_set.push(HeapItem { priority, node_idx });
                }
            }
        }

        if self.open_set.is_empty() && self.best_target_history.is_none() {
            return Err("Start nodes not found in graph".to_string());
        }

        Ok(())
    }

    /// Executes the main priority-queue A* search loop.
    fn run_search(&mut self, ctx: &SearchPassContext) -> Result<(), String> {
        while let Some(item) = self.open_set.pop() {
            let curr = self.node_pool.free(item.node_idx);
            self.nodes_popped += 1;
            if curr.node_id == 0 {
                self.final_cost = curr.cost;
                self.best_target_history = Some(curr.history_idx);
                break;
            }
            if curr.priority >= self.final_cost {
                break;
            }
            if let Some(max_cost) = self.max_cost_limit {
                if ctx.air_distance_factor == 0.0 && curr.cost >= max_cost {
                    break;
                }
                if curr.cost + curr.air_dist > max_cost {
                    continue;
                }
            }

            if curr.edge_idx != u32::MAX {
                if self.is_edge_closed(curr.edge_idx) {
                    continue;
                }
                if let Some(edge_entry) = self.get_edge_state(curr.edge_idx) {
                    let mut dominated = false;
                    let curr_cand = CandidateState::new(curr.cost, curr.path_state.ehbd, curr.path_state.ehbu);
                    for cand in edge_entry.candidates() {
                        if cand.cost < curr.cost
                            && curr_cand.is_definitely_worse_than(cand, curr.down_div, curr.up_div)
                        {
                            dominated = true;
                            break;
                        }
                    }
                    if dominated {
                        continue;
                    }
                }
                self.mark_edge_closed(curr.edge_idx);

                // Bidirectional counterlink closure: if counterlink has no path yet and no turn restrictions, close it
                if !ctx.consider_tr
                    && curr.rev_edge_idx != u32::MAX
                    && !self.is_edge_closed(curr.rev_edge_idx)
                    && !self.has_edge_state(curr.rev_edge_idx)
                {
                    self.mark_edge_closed(curr.rev_edge_idx);
                }
            }

            // Pop cost-cutting with elevation correction
            if let Some(guide) = ctx.cost_cutting {
                if let Some(p0_link_cost) = guide.get_cost(curr.edge_idx) {
                    let elev_corr = StdPathCalculator::elevation_correction(
                        curr.path_state.ehbd,
                        curr.path_state.ehbu,
                        curr.down_div,
                        curr.up_div,
                    );
                    let remaining_p0 = guide.pass0_total_cost.saturating_sub(p0_link_cost);
                    let cost_estimate = curr.cost + elev_corr + remaining_p0;
                    if let Some(ref mut max_cost) = self.max_cost_limit {
                        if cost_estimate < *max_cost {
                            *max_cost = cost_estimate;
                        }
                    }
                }
            }

            // Standalone target node check
            if ctx.target_id1 == ctx.target_id2
                && curr.node_id == ctx.target_id1
                && curr.cost < self.final_cost
            {
                self.final_cost = curr.cost;
                self.best_target_history = Some(curr.history_idx);
                break;
            }

            let edges = ctx.graph.get_edges_by_slice(curr.out_edges_start, curr.out_edges_count);
            if edges.is_empty() {
                continue;
            }

            // Check if curr node has turn restrictions (only if profile considers TRs and not start node)
            let curr_trs: &[DecodedTurnRestriction] = if ctx.consider_tr
                && curr.from_node_id != 0
                && !ctx.graph.turn_restrictions.is_empty()
            {
                ctx.graph
                    .turn_restrictions
                    .get(&curr.node_id)
                    .map(|v| v.as_slice())
                    .unwrap_or(&[])
            } else {
                &[]
            };

            // Check if curr node has estimated_crossing_class (only if crossing evaluation is active)
            let crossing_class = if ctx.crossing_cfg.consider_crossing
                && curr.priority_classifier >= ctx.crossing_cfg.crossing_prio_h
            {
                if let Some(c_idx) = ctx.crossing_tag_idx {
                    if let Some(curr_node) = ctx.graph.nodes.get(&curr.node_id) {
                        if let Some(ref desc) = curr_node.node_description {
                            ctx.lookups
                                .node
                                .decode_into(&mut self.node_lookup_buf, false, desc);
                            let v_idx = self.node_lookup_buf[c_idx];
                            if v_idx > 0
                                && c_idx < ctx.lookups.node.values.len()
                                && (v_idx as usize) < ctx.lookups.node.values[c_idx].len()
                            {
                                let val_str = &ctx.lookups.node.values[c_idx][v_idx as usize].value;
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

            for (edge_idx, edge) in edges.iter().enumerate() {
                self.edges_evaluated += 1;
                self.relax_edge(ctx, &curr, edge_idx, edge, curr_trs, crossing_class);
            }
        }
        Ok(())
    }

    /// Evaluates and relaxes an outgoing directed edge from the currently expanded node.
    #[inline(always)]
    fn relax_edge(
        &mut self,
        ctx: &SearchPassContext,
        curr: &SearchNode,
        edge_idx: usize,
        edge: &GraphEdge,
        curr_trs: &[DecodedTurnRestriction],
        crossing_class: Option<u8>,
    ) {
        // Prevent immediate backtrack / U-turn
        if curr.from_node_id != 0 && edge.target_id == curr.from_node_id {
            return;
        }

        // Fast-skip dead-end neighbors that cannot reach the destination
        if edge.is_target_dead_end
            && edge.target_id != ctx.target_id1
            && edge.target_id != ctx.target_id2
            && !ctx.protected_nodes.contains(&edge.target_id)
        {
            return;
        }

        // Fast-skip edges that have already been closed
        if self.is_edge_closed(edge.edge_idx) {
            return;
        }

        let Some(way_cost) = get_way_cost(ctx.cached_way_costs, edge.desc_id, edge.is_reverse)
        else {
            return;
        };

        if way_cost.costfactor >= 9999.0 {
            return; // forbidden way
        }

        // Initial cost on classifier change
        let new_classifier = way_cost.initialclassifier;
        let new_initial_cost = way_cost.initialcost;
        let mut classifier_cost = 0u32;
        if new_classifier != 0
            && curr.last_classifier != 0
            && new_classifier != curr.last_classifier
        {
            if new_initial_cost >= 1_000_000.0 {
                return;
            }
            classifier_cost = new_initial_cost as u32;
        }

        let is_destination = (way_cost.classifiermask & 64) != 0;
        let mut new_destination = curr.in_destination;
        let mut can_leave = curr.can_leave_destination;
        if is_destination {
            new_destination = true;
        } else if new_destination {
            if !can_leave {
                return;
            }
            new_destination = false;
            can_leave = false;
        }

        let mut air_dist_opt = None;
        if let Some(max_cost) = self.max_cost_limit {
            let d = spatial::distance(
                Point2D::new(edge.target_lon, edge.target_lat),
                ctx.target_mwp.crosspoint,
            ) as u32;
            if curr.cost + d > max_cost {
                return;
            }
            air_dist_opt = Some(d);
        }

        let t_elev = if ctx.graph.is_resolved || edge.target_selev != i16::MIN {
            edge.target_selev
        } else {
            ctx.graph
                .nodes
                .get(&edge.target_id)
                .map(|n| n.selev)
                .unwrap_or(curr.selev)
        };

        let is_straight = edge.geometry.is_empty();
        let prev_pt = Point2D::new(curr.prev_lon, curr.prev_lat);
        if is_straight {
            if !curr_trs.is_empty()
                && DecodedTurnRestriction::is_turn_forbidden(
                    curr_trs,
                    prev_pt,
                    Point2D::new(edge.target_lon, edge.target_lat),
                    ctx.is_bike_mode,
                    ctx.is_car_mode,
                )
            {
                return;
            }
        } else {
            edge.fill_polyline(&mut self.poly_buf, curr.ilon, curr.ilat, curr.selev, t_elev);
            if self.poly_buf.len() < 2 {
                return;
            }
            if !curr_trs.is_empty()
                && DecodedTurnRestriction::is_turn_forbidden(
                    curr_trs,
                    prev_pt,
                    self.poly_buf[1].to_2d(),
                    ctx.is_bike_mode,
                    ctx.is_car_mode,
                )
            {
                return;
            }
        }

        let is_target_link = (curr.node_id == ctx.target_id1 && edge.target_id == ctx.target_id2)
            || (curr.node_id == ctx.target_id2 && edge.target_id == ctx.target_id1);

        if is_target_link {
            if is_straight {
                edge.fill_polyline(&mut self.poly_buf, curr.ilon, curr.ilat, curr.selev, t_elev);
            }
            let sliced = slice_to_crosspoint(
                &self.poly_buf,
                ctx.target_mwp.crosspoint,
            );
            if sliced.len() >= 2 {
                let mut path_state = curr.path_state;
                let edge_ctx = EdgeContext {
                    crossing_class,
                    old_prio: curr.priority_classifier,
                    prev_point: prev_pt,
                    is_start: false,
                    is_detail: false,
                };
                let (mut edge_cost, _, _, _, penultimate_pt) = process_polyline(
                    &sliced,
                    &mut path_state,
                    way_cost,
                    &ctx.routing_configs(),
                    &edge_ctx,
                );
                edge_cost += classifier_cost;

                let target_cost = curr.cost + edge_cost;
                if target_cost < self.final_cost {
                    self.final_cost = target_cost;
                    let h_idx = self.history.len() as u32;
                    self.sliced_map.insert(h_idx, sliced);
                    self.history.push(HistoryStep {
                        node_id: 0,
                        from_node_id: curr.node_id,
                        cost: target_cost,
                        global_edge_idx: edge.edge_idx,
                        edge_idx: edge_idx as u16,
                        maxspeed: way_cost.maxspeed,
                        prev_idx: curr.history_idx,
                    });
                    let node_idx = self.node_pool.alloc(SearchNode {
                        node_id: 0,
                        from_node_id: curr.node_id,
                        ilon: ctx.target_mwp.crosspoint.lon,
                        ilat: ctx.target_mwp.crosspoint.lat,
                        cost: target_cost,
                        air_dist: 0,
                        priority: target_cost,
                        path_state,
                        prev_lon: penultimate_pt.lon,
                        prev_lat: penultimate_pt.lat,
                        priority_classifier: curr.priority_classifier,
                        down_div: 0,
                        up_div: 0,
                        history_idx: h_idx,
                        selev: 0,
                        last_classifier: 0,
                        in_destination: false,
                        can_leave_destination: false,
                        edge_idx: edge.edge_idx,
                        rev_edge_idx: edge.rev_edge_idx,
                        out_edges_start: 0,
                        out_edges_count: 0,
                    });
                    self.open_set.push(HeapItem {
                        priority: target_cost,
                        node_idx,
                    });
                    self.best_target_history = Some(h_idx);
                }
            }
            return;
        }

        let mut path_state = curr.path_state;
        let edge_ctx = EdgeContext {
            crossing_class,
            old_prio: curr.priority_classifier,
            prev_point: prev_pt,
            is_start: false,
            is_detail: false,
        };
        let (mut edge_cost, edge_dist, _, _, penultimate_pt) = if is_straight {
            let seg_dist = if edge.straight_dist > 0.0 {
                edge.straight_dist
            } else {
                spatial::distance(
                    Point2D::new(curr.ilon, curr.ilat),
                    Point2D::new(edge.target_lon, edge.target_lat),
                )
                .round()
                .max(1.0)
            };
            process_straight_edge(
                Point3D::new(curr.ilon, curr.ilat, curr.selev),
                Point3D::new(edge.target_lon, edge.target_lat, t_elev),
                seg_dist,
                &mut path_state,
                way_cost,
                &ctx.routing_configs(),
                &edge_ctx,
            )
        } else {
            process_polyline(
                &self.poly_buf,
                &mut path_state,
                way_cost,
                &ctx.routing_configs(),
                &edge_ctx,
            )
        };
        edge_cost += classifier_cost;

        if let Some(ref_nodes) = ctx.ref_nodes {
            let source_id = Point2D::new(curr.ilon, curr.ilat).node_id();
            let target_id = edge.target_id;
            if ref_nodes.contains(&source_id) && ref_nodes.contains(&target_id) {
                let reftrackcost = edge_dist.round().max(1.0) as u32;
                edge_cost += reftrackcost;
            }
        }

        // Check node costs for target node
        if edge.has_node_desc
            || (!ctx.graph.is_resolved && ctx.graph.nodes.contains_key(&edge.target_id))
        {
            if let Some(target_node) = ctx.graph.nodes.get(&edge.target_id) {
                if let Some(ref node_desc) = target_node.node_description {
                    if let Some(desc_bytes) = edge.description(ctx.graph) {
                        ctx.lookups.way.decode_into(
                            &mut self.way_lookup_buf,
                            edge.is_reverse,
                            desc_bytes,
                        );
                        self.evaluator.evaluate_way(&self.way_lookup_buf);
                    }
                    ctx.lookups.node.decode_into(
                        &mut self.node_lookup_buf,
                        way_cost.nodeaccessgranted,
                        node_desc,
                    );
                    let node_res = self.evaluator.evaluate_node(&self.node_lookup_buf);
                    if node_res.initialcost >= 1_000_000.0 {
                        return; // blocked node
                    }
                    edge_cost += node_res.initialcost as u32;
                }
            }
        }

        let new_cost = curr.cost + edge_cost;
        let (down_div, up_div) = StdPathCalculator::cost_divisors(way_cost);

        if let Some(guide) = ctx.cost_cutting {
            if let Some(p0_link_cost) = guide.get_cost(edge.edge_idx) {
                let elev_corr = StdPathCalculator::elevation_correction(
                    path_state.ehbd,
                    path_state.ehbu,
                    down_div,
                    up_div,
                );
                let remaining_p0 = guide.pass0_total_cost.saturating_sub(p0_link_cost);
                let cost_estimate = new_cost + elev_corr + remaining_p0;
                if let Some(ref mut max_cost) = self.max_cost_limit {
                    if cost_estimate < *max_cost {
                        *max_cost = cost_estimate;
                    }
                }
            }
        }

        if new_cost >= self.final_cost {
            return;
        }
        if let Some(max_cost) = self.max_cost_limit {
            let d = air_dist_opt.unwrap_or_else(|| {
                spatial::distance(
                    Point2D::new(edge.target_lon, edge.target_lat),
                    ctx.target_mwp.crosspoint,
                ) as u32
            });
            if new_cost + d > max_cost {
                return;
            }
            air_dist_opt = Some(d);
        }

        if self.is_edge_closed(edge.edge_idx) {
            return;
        }

        // Fast dominance check against existing candidate paths on this edge (if any exist)
        let new_cand = CandidateState::new(new_cost, path_state.ehbd, path_state.ehbu);
        let entry_idx = self.edge_heads[edge.edge_idx as usize];
        if entry_idx != u32::MAX {
            let edge_entry = &self.edge_states_pool[entry_idx as usize];
            let mut dominated = false;
            for cand in edge_entry.candidates() {
                if new_cand.is_definitely_worse_than(cand, down_div, up_div) {
                    dominated = true;
                    break;
                }
            }
            if dominated {
                return;
            }
        }

        let edge_entry = self.get_or_create_edge_state(edge.edge_idx);
        edge_entry.retain(|cand| {
            !cand.is_definitely_worse_than(&new_cand, down_div, up_div)
        });

        edge_entry.push(new_cand);

        let air_dist = air_dist_opt.unwrap_or_else(|| {
            spatial::distance(
                Point2D::new(edge.target_lon, edge.target_lat),
                ctx.target_mwp.crosspoint,
            ) as u32
        });
        let priority = new_cost + (air_dist as f64 * ctx.air_distance_factor) as u32;

        let h_idx = self.history.len() as u32;
        self.history.push(HistoryStep {
            node_id: edge.target_id,
            from_node_id: curr.node_id,
            cost: new_cost,
            global_edge_idx: edge.edge_idx,
            edge_idx: edge_idx as u16,
            maxspeed: way_cost.maxspeed,
            prev_idx: curr.history_idx,
        });

        let node_idx = self.node_pool.alloc(SearchNode {
            node_id: edge.target_id,
            from_node_id: curr.node_id,
            ilon: edge.target_lon,
            ilat: edge.target_lat,
            cost: new_cost,
            air_dist,
            priority,
            path_state,
            prev_lon: penultimate_pt.lon,
            prev_lat: penultimate_pt.lat,
            priority_classifier: way_cost.priorityclassifier,
            down_div,
            up_div,
            history_idx: h_idx,
            selev: t_elev,
            last_classifier: new_classifier,
            in_destination: new_destination,
            can_leave_destination: can_leave,
            edge_idx: edge.edge_idx,
            rev_edge_idx: edge.rev_edge_idx,
            out_edges_start: edge.target_edges_start,
            out_edges_count: edge.target_edges_count,
        });
        self.open_set.push(HeapItem { priority, node_idx });
    }

    /// Reconstructs the winning route track by backtracking through search history.
    fn reconstruct_track(&self, _ctx: &SearchPassContext) -> Result<SearchTrack, String> {
        let Some(target_h_idx) = self.best_target_history else {
            return Err("No path found between waypoints".to_string());
        };

        let mut steps = Vec::new();
        let mut curr_idx = target_h_idx;
        while curr_idx != u32::MAX {
            let h = self.history[curr_idx as usize];
            let sliced = self.sliced_map.get(&curr_idx).cloned();
            steps.push(TrackStep {
                node_id: h.node_id,
                from_node_id: h.from_node_id,
                cost: h.cost,
                global_edge_idx: h.global_edge_idx,
                edge_idx: h.edge_idx,
                maxspeed: h.maxspeed,
                sliced_points: sliced,
            });
            curr_idx = h.prev_idx;
        }
        steps.reverse();

        println!(
            "        [STATS] popped: {}, edges: {}",
            self.nodes_popped, self.edges_evaluated
        );

        Ok(SearchTrack {
            steps,
            total_cost: self.final_cost,
        })
    }
}

/// Evaluates cost, distance, time, and kinematics along a straight 2-point edge without polyline allocation.
#[inline]
fn process_straight_edge(
    s_pt: Point3D,
    t_pt: Point3D,
    seg_dist: Distance,
    path_state: &mut PathState,
    way_cost: &crate::dsl::evaluator::WayCostResult,
    configs: &RoutingConfigs,
    edge_ctx: &EdgeContext,
) -> (Cost, Distance, Seconds, Joules, Point2D) {
    let delta_h_micros = if s_pt.elev == i16::MIN || t_pt.elev == i16::MIN {
        0
    } else {
        (t_pt.elev - s_pt.elev) as i32 * 250_000
    };

    let need_crossing =
        !edge_ctx.is_start && configs.crossing.consider_crossing && edge_ctx.old_prio > 0;
    let need_angle = !edge_ctx.is_start && (way_cost.turncost > 0.0 || need_crossing);

    let (angle, cos_angle) = if need_angle {
        calc_angle(edge_ctx.prev_point, s_pt.to_2d(), t_pt.to_2d())
    } else {
        (0.0, 1.0)
    };

    let crossing_penalty = if need_crossing {
        if edge_ctx.old_prio >= configs.crossing.crossing_prio_h
            && way_cost.priorityclassifier <= configs.crossing.crossing_prio_l
        {
            if let Some(cls) = edge_ctx.crossing_class {
                if (1..=6).contains(&cls) {
                    let idx = (cls - 1) as usize;
                    if angle < 0.0 {
                        configs.crossing.cost_to_left[idx]
                    } else if angle > 0.0 {
                        configs.crossing.cost_to_right[idx]
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
        configs.elev,
        configs.kinematic,
        &SectionInput {
            dist: seg_dist,
            delta_h_micros,
            cos_angle,
            crossing_penalty,
            is_detail: edge_ctx.is_detail,
        },
    );

    (
        sec.section_cost_int,
        seg_dist,
        sec.time_seconds,
        sec.energy_joules,
        s_pt.to_2d(),
    )
}

/// Evaluates cost, distance, time, and kinematics along a polyline.
fn process_polyline(
    poly: &[Point3D],
    path_state: &mut PathState,
    way_cost: &crate::dsl::evaluator::WayCostResult,
    configs: &RoutingConfigs,
    edge_ctx: &EdgeContext,
) -> (Cost, Distance, Seconds, Joules, Point2D) {
    let mut edge_cost = 0;
    let mut edge_dist = 0.0;
    let mut edge_time = 0.0;
    let mut edge_energy = 0.0;

    let mut p_prev = edge_ctx.prev_point;

    for i in 0..poly.len() - 1 {
        let p1 = &poly[i];
        let p2 = &poly[i + 1];

        let seg_dist = distance(p1.to_2d(), p2.to_2d()).round().max(1.0);
        if seg_dist <= 0.0 {
            continue;
        }

        let delta_h_micros = if p1.elev == i16::MIN || p2.elev == i16::MIN {
            0
        } else {
            (p2.elev - p1.elev) as i32 * 250_000
        };

        let is_junction = i == 0;
        let need_crossing = is_junction
            && !edge_ctx.is_start
            && configs.crossing.consider_crossing
            && edge_ctx.old_prio > 0;
        let need_angle = if is_junction {
            !edge_ctx.is_start && (way_cost.turncost > 0.0 || need_crossing)
        } else {
            way_cost.turncost > 0.0
        };

        let (angle, cos_angle) = if need_angle {
            calc_angle(p_prev, p1.to_2d(), p2.to_2d())
        } else {
            (0.0, 1.0)
        };

        let crossing_penalty = if need_crossing {
            if edge_ctx.old_prio >= configs.crossing.crossing_prio_h
                && way_cost.priorityclassifier <= configs.crossing.crossing_prio_l
            {
                if let Some(cls) = edge_ctx.crossing_class {
                    if (1..=6).contains(&cls) {
                        let idx = (cls - 1) as usize;
                        if angle < 0.0 {
                            configs.crossing.cost_to_left[idx]
                        } else if angle > 0.0 {
                            configs.crossing.cost_to_right[idx]
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
            configs.elev,
            configs.kinematic,
            &SectionInput {
                dist: seg_dist,
                delta_h_micros,
                cos_angle,
                crossing_penalty,
                is_detail: edge_ctx.is_detail,
            },
        );

        edge_cost += sec.section_cost_int;
        edge_dist += seg_dist;
        edge_time += sec.time_seconds;
        edge_energy += sec.energy_joules;

        p_prev = p1.to_2d();
    }

    let penultimate_pt = if poly.len() >= 2 {
        poly[poly.len() - 2].to_2d()
    } else {
        edge_ctx.prev_point
    };

    (
        edge_cost,
        edge_dist,
        edge_time,
        edge_energy,
        penultimate_pt,
    )
}
