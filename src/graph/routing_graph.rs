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

use crate::dsl::evaluator::ProfileEvaluator;
use crate::dsl::lookups::LookupData;
use crate::rd5::micro_cache::{DecodedGeometryPoint, DecodedMicroCache, DecodedTurnRestriction};
use super::matcher::{MatchedWaypoint, WaypointMatcher};
use super::node::{make_node_id, OsmNode};
use super::spatial;

pub const NO_DESC: u32 = u32::MAX;

/// Directed edge in the routing graph with polyline geometry.
#[derive(Debug, Clone)]
pub struct GraphEdge {
    pub target_id: u64,
    pub target_lon: i32,
    pub target_lat: i32,
    pub desc_id: u32,
    pub target_selev: i16,
    pub is_reverse: bool,
    pub geometry: Vec<DecodedGeometryPoint>,
}

impl GraphEdge {
    /// Returns the raw description bytes from the graph if present.
    #[inline]
    pub fn description<'a>(&self, graph: &'a RoutingGraph) -> Option<&'a [u8]> {
        if self.desc_id == NO_DESC {
            None
        } else {
            graph.descriptions.get(self.desc_id as usize).map(|v| v.as_slice())
        }
    }

    /// Fills an existing polyline buffer (source, intermediates, target) without allocating.
    pub fn fill_polyline(
        &self,
        pts: &mut Vec<(i32, i32, i16)>,
        s_lon: i32,
        s_lat: i32,
        s_elev: i16,
        t_elev: i16,
    ) {
        pts.clear();
        pts.reserve(self.geometry.len() + 2);
        pts.push((s_lon, s_lat, s_elev));

        if !self.is_reverse {
            let mut olon = s_lon;
            let mut olat = s_lat;
            let mut oelev = s_elev;
            for gp in &self.geometry {
                olon += gp.dlon;
                olat += gp.dlat;
                oelev = oelev.wrapping_add(gp.delev as i16);
                pts.push((olon, olat, oelev));
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
                pts.push((olon, olat, oelev));
            }
            pts[start_rev..].reverse();
        }

        pts.push((self.target_lon, self.target_lat, t_elev));
    }

    /// Expands the full polyline of coordinates (source, intermediates, target)
    /// in forward traversal order (source to target).
    pub fn polyline(
        &self,
        s_lon: i32,
        s_lat: i32,
        s_elev: i16,
        t_elev: i16,
    ) -> Vec<(i32, i32, i16)> {
        let mut pts = Vec::with_capacity(self.geometry.len() + 2);
        self.fill_polyline(&mut pts, s_lon, s_lat, s_elev, t_elev);
        pts
    }

    /// Calculates the geodesic length in meters along this edge's full polyline.
    pub fn compute_distance(
        &self,
        s_lon: i32,
        s_lat: i32,
        s_elev: i16,
        t_elev: i16,
    ) -> f64 {
        let pts = self.polyline(s_lon, s_lat, s_elev, t_elev);
        let mut dist = 0.0;
        for i in 0..pts.len() - 1 {
            dist += spatial::distance(pts[i].0, pts[i].1, pts[i + 1].0, pts[i + 1].1);
        }
        dist
    }
}

/// In-memory graph representing the road network for routing.
#[derive(Debug, Default, Clone)]
pub struct RoutingGraph {
    pub nodes: HashMap<u64, OsmNode>,
    pub edges: HashMap<u64, Vec<GraphEdge>>,
    pub elevation_types: HashMap<(i32, i32), u8>,
    pub descriptions: Vec<Vec<u8>>,
    pub desc_to_id: HashMap<Vec<u8>, u32>,
}

impl RoutingGraph {
    pub fn new() -> Self {
        Self {
            nodes: HashMap::new(),
            edges: HashMap::new(),
            elevation_types: HashMap::new(),
            descriptions: Vec::new(),
            desc_to_id: HashMap::new(),
        }
    }

    pub fn with_capacities(node_cap: usize, edge_cap: usize) -> Self {
        Self {
            nodes: HashMap::with_capacity(node_cap),
            edges: HashMap::with_capacity(edge_cap),
            elevation_types: HashMap::new(),
            descriptions: Vec::new(),
            desc_to_id: HashMap::new(),
        }
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
                && (e.desc_id == edge.desc_id
                    || e.desc_id == NO_DESC
                    || edge.desc_id == NO_DESC)
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
            let n_desc = node.node_tags.map(|t| t.data);

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

                self.nodes.entry(t_id).or_insert_with(|| OsmNode::new(link.target_lon, link.target_lat));

                let desc_id = self.get_or_intern_description(link.way_tags.as_ref().map(|t| t.data.as_slice()));

                let edge_fwd = GraphEdge {
                    target_id: t_id,
                    target_lon: link.target_lon,
                    target_lat: link.target_lat,
                    is_reverse: link.is_reverse,
                    target_selev: t_selev,
                    desc_id,
                    geometry: link.geometry.clone(),
                };
                self.insert_or_update_edge(s_id, edge_fwd);

                let edge_rev = GraphEdge {
                    target_id: s_id,
                    target_lon: s_lon,
                    target_lat: s_lat,
                    is_reverse: !link.is_reverse,
                    target_selev: s_elev,
                    desc_id,
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
        self.edges.values().map(|v| v.len()).sum()
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

        let mut mwp = MatchedWaypoint::new(name, wp_lon, wp_lat, max_distance_meters);
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
        let mut poly = Vec::with_capacity(32);

        for (s_id, edge_vec) in &self.edges {
            let (s_ilon, s_ilat) = super::node::unpack_node_id(*s_id);

            // Check if source node is reasonably near the bounding box
            if s_ilon < min_lon - 50000 || s_ilon > max_lon + 50000 {
                continue;
            }
            if s_ilat < min_lat - 50000 || s_ilat > max_lat + 50000 {
                continue;
            }

            let Some(source_node) = self.nodes.get(s_id) else {
                continue;
            };

            for edge in edge_vec {
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
                    let seg_min_lon = p1.0.min(p2.0);
                    let seg_max_lon = p1.0.max(p2.0);
                    let seg_min_lat = p1.1.min(p2.1);
                    let seg_max_lat = p1.1.max(p2.1);

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
                        p1.0,
                        p1.1,
                        p2.0,
                        p2.1,
                        source_node.ilon,
                        source_node.ilat,
                        edge.target_lon,
                        edge.target_lat,
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

    /// Resolves target node elevation for all edges.
    pub fn resolve_edge_target_elevations(&mut self) {
        for edges in self.edges.values_mut() {
            for edge in edges.iter_mut() {
                if edge.target_selev == i16::MIN {
                    if let Some(target_node) = self.nodes.get(&edge.target_id) {
                        edge.target_selev = target_node.selev;
                    }
                }
            }
        }
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
        self.elevation_types.get(&(lon_deg, lat_deg)).copied().unwrap_or(3)
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

