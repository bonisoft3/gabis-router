//! Rust implementation corresponding to:
//! - Java class: `btools.mapaccess.OsmNodesMap`
//! - Java source: `https://github.com/abrensch/brouter/blob/master/brouter-mapaccess/src/main/java/btools/mapaccess/OsmNodesMap.java`
//! - Java class: `btools.mapaccess.NodesCache`
//! - Java source: `https://github.com/abrensch/brouter/blob/master/brouter-mapaccess/src/main/java/btools/mapaccess/NodesCache.java`
//!
//! # Summary
//! High-performance in-memory routing graph container holding nodes and directed edges,
//! built from decoded RD5 MicroCache tiles with spatial waypoint snapping.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use super::fast_map::FastHashMap;
use super::matcher::{MatchedWaypoint, WaypointMatcher};
use super::node::{make_node_id, OsmNode};
use super::spatial;
use crate::dsl::evaluator::ProfileEvaluator;
use crate::dsl::lookups::LookupData;
use crate::rd5::micro_cache::{DecodedGeometryPoint, DecodedMicroCache, DecodedTurnRestriction};
use crate::types::{Distance, ElevationQuarterMeters, MicroDegrees, NodeId, Point2D, Point3D};

pub const NO_DESC: u32 = u32::MAX;

/// Directed edge in the routing graph with polyline geometry and direct target slice links.
#[derive(Debug, Clone)]
pub struct GraphEdge {
    pub source_id: NodeId,
    pub target_id: NodeId,
    pub target_lon: MicroDegrees,
    pub target_lat: MicroDegrees,
    pub desc_id: u32,
    pub edge_idx: u32,
    pub rev_edge_idx: u32,
    pub target_selev: ElevationQuarterMeters,
    pub is_reverse: bool,
    pub has_node_desc: bool,
    pub is_target_dead_end: bool,
    pub target_edges_start: u32,
    pub target_edges_count: u16,
    pub straight_dist: Distance,
    pub geometry: Vec<DecodedGeometryPoint>,
}

impl GraphEdge {
    /// Returns the raw description bytes from the graph if present.
    #[inline]
    pub fn description<'a>(&self, graph: &'a RoutingGraph) -> Option<&'a [u8]> {
        if self.desc_id == NO_DESC {
            None
        } else {
            graph
                .descriptions
                .get(self.desc_id as usize)
                .map(|v| v.as_slice())
        }
    }

    /// Fills an existing polyline buffer (source, intermediates, target) without allocating.
    pub fn fill_polyline(
        &self,
        pts: &mut Vec<Point3D>,
        s_lon: i32,
        s_lat: i32,
        s_elev: i16,
        t_elev: i16,
    ) {
        pts.clear();
        pts.reserve(self.geometry.len() + 2);
        pts.push(Point3D::new(s_lon, s_lat, s_elev));

        if !self.is_reverse {
            let mut olon = s_lon;
            let mut olat = s_lat;
            let mut oelev = s_elev;
            for gp in &self.geometry {
                olon += gp.dlon;
                olat += gp.dlat;
                oelev = oelev.wrapping_add(gp.delev as i16);
                pts.push(Point3D::new(olon, olat, oelev));
            }
        } else {
            let mut olon = self.target_lon;
            let mut olat = self.target_lat;
            let mut oelev = t_elev;
            let start_rev = pts.len();
            for gp in &self.geometry {
                olon += gp.dlon;
                olat += gp.dlat;
                oelev = oelev.wrapping_add(gp.delev as i16);
                pts.push(Point3D::new(olon, olat, oelev));
            }
            pts[start_rev..].reverse();
        }

        pts.push(Point3D::new(self.target_lon, self.target_lat, t_elev));
    }

    /// Expands the full polyline of coordinates (source, intermediates, target)
    /// in forward traversal order (source to target).
    pub fn polyline(
        &self,
        s_lon: i32,
        s_lat: i32,
        s_elev: i16,
        t_elev: i16,
    ) -> Vec<Point3D> {
        let mut pts = Vec::with_capacity(self.geometry.len() + 2);
        self.fill_polyline(&mut pts, s_lon, s_lat, s_elev, t_elev);
        pts
    }
}

/// In-memory graph representing the road network for routing.
#[derive(Debug, Default, Clone)]
pub struct RoutingGraph {
    pub nodes: FastHashMap<u64, OsmNode>,
    pub edges: FastHashMap<u64, Vec<GraphEdge>>,
    pub flat_edges: Vec<GraphEdge>,
    pub node_edge_offsets: FastHashMap<u64, (u32, u16)>,
    pub turn_restrictions: FastHashMap<u64, Vec<DecodedTurnRestriction>>,
    pub way_cost_cache: Arc<RwLock<FastHashMap<String, Arc<Vec<crate::dsl::evaluator::WayCostResult>>>>>,
    pub elevation_types: FastHashMap<(i32, i32), u8>,
    pub descriptions: Vec<Vec<u8>>,
    pub desc_to_id: HashMap<Vec<u8>, u32>,
    pub spatial_grid: FastHashMap<(i32, i32), Vec<u64>>,
    pub is_resolved: bool,
    pub total_edges: usize,
    pub dead_end_parents: FastHashMap<u64, u64>,
}

pub const GRID_CELL_SIZE: i32 = 10_000;

impl RoutingGraph {
    pub fn new() -> Self {
        Self {
            nodes: FastHashMap::default(),
            edges: FastHashMap::default(),
            flat_edges: Vec::new(),
            node_edge_offsets: FastHashMap::default(),
            turn_restrictions: FastHashMap::default(),
            way_cost_cache: Arc::new(RwLock::new(FastHashMap::default())),
            elevation_types: FastHashMap::default(),
            descriptions: Vec::new(),
            desc_to_id: HashMap::new(),
            spatial_grid: FastHashMap::default(),
            is_resolved: false,
            total_edges: 0,
            dead_end_parents: FastHashMap::default(),
        }
    }

    pub fn with_capacities(node_cap: usize, edge_cap: usize) -> Self {
        Self {
            nodes: FastHashMap::with_capacity_and_hasher(node_cap, Default::default()),
            edges: FastHashMap::with_capacity_and_hasher(edge_cap, Default::default()),
            flat_edges: Vec::with_capacity(edge_cap),
            node_edge_offsets: FastHashMap::with_capacity_and_hasher(node_cap, Default::default()),
            turn_restrictions: FastHashMap::default(),
            way_cost_cache: Arc::new(RwLock::new(FastHashMap::default())),
            elevation_types: FastHashMap::default(),
            descriptions: Vec::new(),
            desc_to_id: HashMap::new(),
            spatial_grid: FastHashMap::default(),
            is_resolved: false,
            total_edges: 0,
            dead_end_parents: FastHashMap::default(),
        }
    }

    /// Retrieves pre-evaluated way costs for a given profile name if cached.
    pub fn get_cached_way_costs(&self, profile_name: &str) -> Option<Arc<Vec<crate::dsl::evaluator::WayCostResult>>> {
        let cache = self.way_cost_cache.read().ok()?;
        cache.get(profile_name).cloned()
    }

    /// Stores pre-evaluated way costs for a given profile name in the graph's cache.
    pub fn insert_cached_way_costs(&self, profile_name: String, costs: Arc<Vec<crate::dsl::evaluator::WayCostResult>>) {
        if let Ok(mut cache) = self.way_cost_cache.write() {
            cache.insert(profile_name, costs);
        }
    }

    /// Returns outgoing edges for the given node ID.
    #[inline(always)]
    pub fn get_edges(&self, s_id: u64) -> &[GraphEdge] {
        if let Some(&(start, count)) = self.node_edge_offsets.get(&s_id) {
            &self.flat_edges[start as usize..(start as usize + count as usize)]
        } else if let Some(v) = self.edges.get(&s_id) {
            v.as_slice()
        } else {
            &[]
        }
    }

    /// Returns outgoing edges directly by precomputed slice offset and count.
    #[inline(always)]
    pub fn get_edges_by_slice(&self, start: u32, count: u16) -> &[GraphEdge] {
        if count == 0 {
            &[]
        } else {
            &self.flat_edges[start as usize..(start as usize + count as usize)]
        }
    }

    /// Returns the precomputed outgoing edge slice offset and count for a node ID.
    #[inline(always)]
    pub fn get_node_edge_slice(&self, s_id: u64) -> (u32, u16) {
        self.node_edge_offsets.get(&s_id).copied().unwrap_or((0, 0))
    }

    pub fn get_or_intern_description(&mut self, desc: Option<&[u8]>) -> u32 {
        match desc {
            None => NO_DESC,
            Some(d) => {
                if let Some(&id) = self.desc_to_id.get(d) {
                    id
                } else {
                    let id = self.descriptions.len() as u32;
                    let v = d.to_vec();
                    self.desc_to_id.insert(v.clone(), id);
                    self.descriptions.push(v);
                    id
                }
            }
        }
    }

    fn insert_or_update_edge(&mut self, s_id: u64, edge: GraphEdge) {
        let edge_list = self.edges.entry(s_id).or_default();
        if let Some(existing) = edge_list.iter_mut().find(|e| {
            e.target_id == edge.target_id
                && e.is_reverse == edge.is_reverse
                && (e.desc_id == edge.desc_id || e.desc_id == NO_DESC || edge.desc_id == NO_DESC)
        }) {
            if existing.geometry.is_empty() && !edge.geometry.is_empty() {
                existing.geometry = edge.geometry;
            }
            if existing.desc_id == NO_DESC && edge.desc_id != NO_DESC {
                existing.desc_id = edge.desc_id;
            }
            if existing.target_selev == i16::MIN && edge.target_selev != i16::MIN {
                existing.target_selev = edge.target_selev;
            }
        } else {
            edge_list.push(edge);
        }
    }

    /// Incorporates a decoded MicroCache cell into the graph.
    pub fn add_micro_cache(&mut self, cache: DecodedMicroCache) {
        for node in cache.nodes {
            let s_id = make_node_id(node.ilon, node.ilat);
            let s_lon = node.ilon;
            let s_lat = node.ilat;
            let s_elev = node.selev;

            let trs: Vec<DecodedTurnRestriction> = node.turn_restrictions;
            if !trs.is_empty() {
                self.turn_restrictions.insert(s_id, trs.clone());
            }
            let n_desc = node.node_tags.map(|t| t.data);
            let has_n_desc = n_desc.is_some();

            let osm_node = OsmNode {
                ilon: s_lon,
                ilat: s_lat,
                selev: s_elev,
                node_description: n_desc,
                turn_restrictions: trs,
            };
            self.nodes.insert(s_id, osm_node);

            for link in node.links {
                let t_id = make_node_id(link.target_lon, link.target_lat);
                let t_selev = self.nodes.get(&t_id).map(|n| n.selev).unwrap_or(i16::MIN);

                self.nodes
                    .entry(t_id)
                    .or_insert_with(|| OsmNode::new(link.target_lon, link.target_lat));

                let desc_id = self
                    .get_or_intern_description(link.way_tags.as_ref().map(|t| t.data.as_slice()));

                let edge_fwd = GraphEdge {
                    source_id: s_id,
                    target_id: t_id,
                    target_lon: link.target_lon,
                    target_lat: link.target_lat,
                    is_reverse: link.is_reverse,
                    target_selev: t_selev,
                    has_node_desc: false,
                    is_target_dead_end: false,
                    target_edges_start: 0,
                    target_edges_count: 0,
                    desc_id,
                    edge_idx: 0,
                    rev_edge_idx: u32::MAX,
                    straight_dist: 0.0,
                    geometry: link.geometry.clone(),
                };
                self.insert_or_update_edge(s_id, edge_fwd);

                let edge_rev = GraphEdge {
                    source_id: t_id,
                    target_id: s_id,
                    target_lon: s_lon,
                    target_lat: s_lat,
                    is_reverse: !link.is_reverse,
                    target_selev: s_elev,
                    has_node_desc: has_n_desc,
                    is_target_dead_end: false,
                    target_edges_start: 0,
                    target_edges_count: 0,
                    desc_id,
                    edge_idx: 0,
                    rev_edge_idx: u32::MAX,
                    straight_dist: 0.0,
                    geometry: link.geometry,
                };
                self.insert_or_update_edge(t_id, edge_rev);
            }
        }
    }

    /// Returns the number of nodes in the graph.
    #[inline]
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// Returns total number of directed edges in the graph.
    pub fn edge_count(&self) -> usize {
        if self.total_edges > 0 {
            self.total_edges
        } else {
            self.edges.values().map(|v| v.len()).sum()
        }
    }

    /// Snaps geographic coordinates `(lon_deg, lat_deg)` to the nearest road edge
    /// within `max_distance_meters` that is accessible according to `evaluator`.
    pub fn snap_waypoint(
        &self,
        name: &str,
        lon_deg: f64,
        lat_deg: f64,
        max_distance_meters: f64,
        evaluator: &mut ProfileEvaluator,
        lookups: &LookupData,
    ) -> Option<MatchedWaypoint> {
        let wp_lon = spatial::lon_to_ilon(lon_deg);
        let wp_lat = spatial::lat_to_ilat(lat_deg);

        let mut mwp = MatchedWaypoint::new(name, Point2D::new(wp_lon, wp_lat), max_distance_meters);
        let mut found = false;

        // Bounding box filter for quick rejection
        let scales = spatial::get_lon_lat_to_meter_scales(wp_lat);
        let max_dlon = (max_distance_meters / scales[0]).ceil() as i32 + 500;
        let max_dlat = (max_distance_meters / scales[1]).ceil() as i32 + 500;

        let min_lon = wp_lon - max_dlon;
        let max_lon = wp_lon + max_dlon;
        let min_lat = wp_lat - max_dlat;
        let max_lat = wp_lat + max_dlat;

        let mut way_lookup_buf = vec![0i32; lookups.way.names.len()];
        let mut poly: Vec<Point3D> = Vec::with_capacity(32);

        let mut candidate_nodes: Vec<u64> = Vec::new();
        if !self.spatial_grid.is_empty() {
            let min_cx = (min_lon - 20000).div_euclid(GRID_CELL_SIZE);
            let max_cx = (max_lon + 20000).div_euclid(GRID_CELL_SIZE);
            let min_cy = (min_lat - 20000).div_euclid(GRID_CELL_SIZE);
            let max_cy = (max_lat + 20000).div_euclid(GRID_CELL_SIZE);
            for cx in min_cx..=max_cx {
                for cy in min_cy..=max_cy {
                    if let Some(nodes) = self.spatial_grid.get(&(cx, cy)) {
                        candidate_nodes.extend_from_slice(nodes);
                    }
                }
            }
        }

        let node_iter: Box<dyn Iterator<Item = u64> + '_> = if !candidate_nodes.is_empty() {
            Box::new(candidate_nodes.into_iter())
        } else if self.is_resolved {
            Box::new(self.node_edge_offsets.keys().copied())
        } else {
            Box::new(self.edges.keys().copied())
        };

        for s_id in node_iter {
            let s_pos = super::node::unpack_node_id(s_id);
            let s_ilon = s_pos.lon;
            let s_ilat = s_pos.lat;

            // Check if source node is reasonably near the bounding box
            if s_ilon < min_lon - 50000 || s_ilon > max_lon + 50000 {
                continue;
            }
            if s_ilat < min_lat - 50000 || s_ilat > max_lat + 50000 {
                continue;
            }

            let Some(source_node) = self.nodes.get(&s_id) else {
                continue;
            };

            let edge_vec = self.get_edges(s_id);
            if edge_vec.is_empty() {
                continue;
            }

            for edge in edge_vec {
                let edge_min_lon = s_ilon.min(edge.target_lon);
                let edge_max_lon = s_ilon.max(edge.target_lon);
                let edge_min_lat = s_ilat.min(edge.target_lat);
                let edge_max_lat = s_ilat.max(edge.target_lat);

                if edge_max_lon + 10000 < min_lon
                    || edge_min_lon - 10000 > max_lon
                    || edge_max_lat + 10000 < min_lat
                    || edge_min_lat - 10000 > max_lat
                {
                    continue;
                }

                let Some(desc_bytes) = edge.description(self) else {
                    continue;
                };
                lookups
                    .way
                    .decode_into(&mut way_lookup_buf, edge.is_reverse, desc_bytes);
                let way_cost = evaluator.evaluate_way(&way_lookup_buf);
                if way_cost.costfactor >= 9999.0 {
                    continue;
                }

                let t_elev = if edge.target_selev != i16::MIN {
                    edge.target_selev
                } else {
                    self.nodes
                        .get(&edge.target_id)
                        .map(|n| n.selev)
                        .unwrap_or(source_node.selev)
                };

                edge.fill_polyline(
                    &mut poly,
                    source_node.ilon,
                    source_node.ilat,
                    source_node.selev,
                    t_elev,
                );

                for i in 0..poly.len() - 1 {
                    let p1 = &poly[i];
                    let p2 = &poly[i + 1];

                    // Segment bounding box check
                    let seg_min_lon = p1.lon.min(p2.lon);
                    let seg_max_lon = p1.lon.max(p2.lon);
                    let seg_min_lat = p1.lat.min(p2.lat);
                    let seg_max_lat = p1.lat.max(p2.lat);

                    if seg_max_lon < min_lon
                        || seg_min_lon > max_lon
                        || seg_max_lat < min_lat
                        || seg_min_lat > max_lat
                    {
                        continue;
                    }

                    let old_radius = mwp.radius;
                    WaypointMatcher::check_segment(
                        &mut mwp,
                        p1.to_2d(),
                        p2.to_2d(),
                        Point2D::new(source_node.ilon, source_node.ilat),
                        Point2D::new(edge.target_lon, edge.target_lat),
                    );
                    if mwp.radius < old_radius {
                        found = true;
                    }
                }
            }
        }

        if found {
            Some(mwp)
        } else {
            None
        }
    }

    /// Resolves target node elevation and node description presence for all edges.
    ///
    /// Precomputes dead-end subtrees via iterative topological leaf peeling matching
    /// Java class `btools.mapaccess.OsmNodesMap`:
    /// Nodes with 0 or 1 outgoing target are peeled as leaves. Each leaf records its
    /// parent node in `dead_end_parents`. When a parent node loses all but one remaining
    /// target, it is in turn peeled into the queue. During routing search, edges leading
    /// into dead-end subtrees are fast-skipped unless the target waypoint lies within that subtree.
    pub fn resolve_edge_target_elevations(&mut self) {
        let mut dead_end_parents: FastHashMap<u64, u64> =
            FastHashMap::with_capacity_and_hasher(self.edges.len() / 4, Default::default());
        let mut queue: Vec<u64> = Vec::new();
        let mut remaining_targets: FastHashMap<u64, Vec<u64>> =
            FastHashMap::with_capacity_and_hasher(self.edges.len(), Default::default());

        for (&s_id, edges) in &self.edges {
            let mut unique_targets: Vec<u64> = Vec::with_capacity(edges.len());
            for e in edges {
                if !unique_targets.contains(&e.target_id) {
                    unique_targets.push(e.target_id);
                }
            }
            if unique_targets.is_empty() {
                dead_end_parents.insert(s_id, 0);
                queue.push(s_id);
            } else if unique_targets.len() == 1 {
                let parent = unique_targets[0];
                dead_end_parents.insert(s_id, parent);
                queue.push(s_id);
            } else {
                remaining_targets.insert(s_id, unique_targets);
            }
        }

        while let Some(leaf) = queue.pop() {
            if let Some(&parent) = dead_end_parents.get(&leaf) {
                if parent != 0 {
                    if let Some(targets) = remaining_targets.get_mut(&parent) {
                        targets.retain(|&t| t != leaf);
                        if targets.len() == 1 {
                            let grand_parent = targets[0];
                            dead_end_parents.insert(parent, grand_parent);
                            queue.push(parent);
                        } else if targets.is_empty() {
                            dead_end_parents.insert(parent, 0);
                            queue.push(parent);
                        }
                    }
                }
            }
        }

        let total_edge_count: usize = self.edges.values().map(|v| v.len()).sum();
        let mut flat_edges = Vec::with_capacity(total_edge_count);
        let mut node_edge_offsets =
            FastHashMap::with_capacity_and_hasher(self.edges.len(), Default::default());

        for (&s_id, edges) in self.edges.iter_mut() {
            let s_pos = super::node::unpack_node_id(s_id);
            let start = flat_edges.len() as u32;
            let count = edges.len() as u16;
            node_edge_offsets.insert(s_id, (start, count));

            for (e_i, edge) in edges.iter_mut().enumerate() {
                edge.edge_idx = start + e_i as u32;
                if let Some(target_node) = self.nodes.get(&edge.target_id) {
                    if edge.target_selev == i16::MIN && target_node.selev != i16::MIN {
                        edge.target_selev = target_node.selev;
                    }
                    edge.has_node_desc = target_node.node_description.is_some();
                }
                if edge.geometry.is_empty() {
                    edge.straight_dist =
                        spatial::distance(s_pos, Point2D::new(edge.target_lon, edge.target_lat))
                            .round()
                            .max(1.0);
                }
                let is_dead = match dead_end_parents.get(&edge.target_id) {
                    Some(&parent) => parent == s_id,
                    None => !self.nodes.contains_key(&edge.target_id),
                };
                edge.is_target_dead_end = is_dead;
            }
            flat_edges.append(edges);
        }

        self.spatial_grid.clear();
        for &s_id in node_edge_offsets.keys() {
            let pos = super::node::unpack_node_id(s_id);
            let cell = (
                pos.lon.div_euclid(GRID_CELL_SIZE),
                pos.lat.div_euclid(GRID_CELL_SIZE),
            );
            self.spatial_grid.entry(cell).or_default().push(s_id);
        }
        self.total_edges = flat_edges.len();

        // Resolve bidirectional counterlink indices and target edge slice offsets
        let mut edge_id_map: FastHashMap<(u64, u64), u32> =
            FastHashMap::with_capacity_and_hasher(self.total_edges, Default::default());
        for edge in &flat_edges {
            edge_id_map.insert((edge.source_id, edge.target_id), edge.edge_idx);
        }

        for edge in flat_edges.iter_mut() {
            if let Some(&rev_idx) = edge_id_map.get(&(edge.target_id, edge.source_id)) {
                edge.rev_edge_idx = rev_idx;
            }
            if let Some(&(t_start, t_count)) = node_edge_offsets.get(&edge.target_id) {
                edge.target_edges_start = t_start;
                edge.target_edges_count = t_count;
            } else {
                edge.target_edges_start = 0;
                edge.target_edges_count = 0;
            }
        }

        self.flat_edges = flat_edges;
        self.node_edge_offsets = node_edge_offsets;
        self.dead_end_parents = dead_end_parents;
        self.edges.clear();
        self.edges.shrink_to_fit();
        self.is_resolved = true;
    }

    /// Loads all microcaches in a bounding box of 1°x1° squares into the graph.
    pub fn load_bounding_box(
        &mut self,
        tile_mgr: &mut crate::rd5::tile_manager::TileManager,
        min_lon: f64,
        min_lat: f64,
        max_lon: f64,
        max_lat: f64,
    ) -> std::io::Result<usize> {
        let min_lon_deg = (min_lon + 180.0).floor() as i32;
        let max_lon_deg = (max_lon + 180.0).floor() as i32;
        let min_lat_deg = (min_lat + 90.0).floor() as i32;
        let max_lat_deg = (max_lat + 90.0).floor() as i32;

        let mut loaded = 0;
        for lon_deg in min_lon_deg..=max_lon_deg {
            for lat_deg in min_lat_deg..=max_lat_deg {
                let elev_type = tile_mgr.get_elevation_type(lon_deg, lat_deg);
                self.elevation_types.insert((lon_deg, lat_deg), elev_type);
                if let Ok(caches) = tile_mgr.decode_all_in_square(lon_deg, lat_deg, None) {
                    for cache in caches {
                        self.add_micro_cache(cache);
                        loaded += 1;
                    }
                }
            }
        }
        self.resolve_edge_target_elevations();
        Ok(loaded)
    }

    /// Returns the elevation type for given microdegree coordinates (1 = 1-arcsec, 3 = 3-arcsec).
    pub fn get_elevation_type(&self, ilon: i32, ilat: i32) -> u8 {
        let lon_deg = ilon / 1_000_000;
        let lat_deg = ilat / 1_000_000;
        self.elevation_types
            .get(&(lon_deg, lat_deg))
            .copied()
            .unwrap_or(3)
    }

    /// Returns the filtered ascend threshold matching BRouter:
    /// -5.0 m for 1-arcsec tiles (elevationType == 1), -10.0 m for 3-arcsec tiles.
    pub fn elevation_filter(&self, ilon: i32, ilat: i32) -> f64 {
        if self.get_elevation_type(ilon, ilat) == 1 {
            -5.0
        } else {
            -10.0
        }
    }
}
