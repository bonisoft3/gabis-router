//! GPS track and GPX map-matching to the routing graph network.
//!
//! # Summary
//! Parses recorded GPX tracks or coordinate sequences, filters GPS jitter and junction
//! side-street snaps using Ramer-Douglas-Peucker simplification and bearing-consistent
//! candidate snapping, routes along the matched corridor, and trims retraced via-point
//! spikes via `RouteResult::merge_with_via_correction`.

use crate::dsl::evaluator::ProfileEvaluator;
use crate::dsl::lookups::LookupData;
use crate::dsl::parser::Profile;
use crate::graph::routing_graph::RoutingGraph;
use crate::graph::spatial::{
    self, distance, get_difference_from_direction, get_direction, lat_to_ilat, lon_to_ilon,
};
use crate::types::Point2D;

use super::cost::KinematicConfig;
use super::search::{AStarRouter, GraphRef};
use super::track::RouteResult;

/// Configuration parameters for snapping a recorded GPS track to the routing graph.
#[derive(Debug, Clone)]
pub struct MapMatchOptions {
    /// Minimum spacing (m) between consecutive raw GPS points to filter stationary drift.
    pub min_point_spacing_m: f64,
    /// Maximum distance (m) between consecutive control waypoints along the track.
    pub sample_step_m: f64,
    /// Ramer-Douglas-Peucker perpendicular tolerance (m) for preserving track turns.
    pub rdp_tolerance_m: f64,
    /// Maximum snapping distance (m) to an accessible road edge.
    pub max_snap_distance_m: f64,
    /// Maximum retraced stub length (m) to trim when correcting misplaced via points at junctions.
    pub via_correction_max_dist_m: f64,
    /// Maximum corridor deviation (m) allowed when extracting minimal profile-matching via points.
    pub deviation_tolerance_m: f64,
    /// Optional turn instruction mode override (`0..=9`).
    pub turn_instruction_mode: Option<i32>,
}

impl Default for MapMatchOptions {
    fn default() -> Self {
        Self {
            min_point_spacing_m: 10.0,
            sample_step_m: 250.0,
            rdp_tolerance_m: 18.0,
            max_snap_distance_m: 200.0,
            via_correction_max_dist_m: 150.0,
            deviation_tolerance_m: 20.0,
            turn_instruction_mode: None,
        }
    }
}

/// Parses `(lon, lat)` coordinate pairs from a GPX XML document (`<trkpt>`, `<rtept>`, or `<wpt>`).
pub fn parse_gpx_points(gpx_xml: &str) -> Result<Vec<(f64, f64)>, String> {
    for tag in ["trkpt", "rtept", "wpt"] {
        let pts = extract_xml_tag_coords(gpx_xml, tag);
        if pts.len() >= 2 {
            return Ok(pts);
        }
    }
    Err("GPX document must contain at least 2 valid track, route, or waypoint coordinates".to_string())
}

fn extract_xml_tag_coords(xml: &str, tag_name: &str) -> Vec<(f64, f64)> {
    let mut coords = Vec::new();
    let pat = format!("<{tag_name}");
    let mut rest = xml;
    while let Some(start) = rest.find(&pat) {
        let after_tag = &rest[start + pat.len()..];
        if !after_tag.starts_with(|c: char| c.is_ascii_whitespace()) {
            rest = after_tag;
            continue;
        }
        let Some(end) = after_tag.find('>') else {
            break;
        };
        let attrs = &after_tag[..end];
        if let (Some(lat), Some(lon)) = (
            extract_xml_attr(attrs, "lat"),
            extract_xml_attr(attrs, "lon"),
        ) {
            if (-180.0..=180.0).contains(&lon) && (-90.0..=90.0).contains(&lat) {
                coords.push((lon, lat));
            }
        }
        rest = &after_tag[end + 1..];
    }
    coords
}

fn extract_xml_attr(attrs: &str, name: &str) -> Option<f64> {
    for quote in ['"', '\''] {
        let pat = format!("{name}={quote}");
        if let Some(pos) = attrs.find(&pat) {
            let val_start = &attrs[pos + pat.len()..];
            if let Some(end) = val_start.find(quote) {
                if let Ok(v) = val_start[..end].trim().parse::<f64>() {
                    return Some(v);
                }
            }
        }
    }
    None
}

/// Perpendicular distance in meters from `pt` to segment `a -> b`.
fn perpendicular_distance_m(pt: Point2D, a: Point2D, b: Point2D) -> f64 {
    let [kx, ky] = spatial::get_lon_lat_to_meter_scales((a.lat + b.lat) >> 1);
    let dx = (b.lon - a.lon) as f64 * kx;
    let dy = (b.lat - a.lat) as f64 * ky;
    let px = (pt.lon - a.lon) as f64 * kx;
    let py = (pt.lat - a.lat) as f64 * ky;
    let len_sq = dx * dx + dy * dy;
    if len_sq <= 1e-6 {
        return (px * px + py * py).sqrt();
    }
    let t = ((px * dx + py * dy) / len_sq).clamp(0.0, 1.0);
    let proj_x = t * dx;
    let proj_y = t * dy;
    ((px - proj_x).powi(2) + (py - proj_y).powi(2)).sqrt()
}

fn rdp_keep_recursive(pts: &[Point2D], start: usize, end: usize, tol_m: f64, keep: &mut [bool]) {
    if end <= start + 1 {
        return;
    }
    let a = pts[start];
    let b = pts[end];
    let mut max_dist = 0.0;
    let mut max_idx = start;
    for (i, &pt) in pts.iter().enumerate().take(end).skip(start + 1) {
        let d = perpendicular_distance_m(pt, a, b);
        if d > max_dist {
            max_dist = d;
            max_idx = i;
        }
    }
    if max_dist > tol_m && max_idx > start {
        keep[max_idx] = true;
        rdp_keep_recursive(pts, start, max_idx, tol_m, keep);
        rdp_keep_recursive(pts, max_idx, end, tol_m, keep);
    }
}

/// Extracts a clean sequence of control waypoints from raw GPS points by filtering jitter,
/// simplifying with Ramer-Douglas-Peucker + max-spacing subdivision, and rejecting interior
/// points that snap onto perpendicular side-street stubs at intersections.
pub fn extract_control_waypoints(
    track_points: &[(f64, f64)],
    graph: &RoutingGraph,
    lookups: &LookupData,
    profile: &Profile,
    options: &MapMatchOptions,
) -> Result<Vec<(f64, f64)>, String> {
    let mut graph_ref = GraphRef::Shared(graph);
    extract_control_waypoints_ref(track_points, &mut graph_ref, lookups, profile, options)
}

#[derive(Clone)]
struct SnappedCandidate {
    coord: (f64, f64),
    edge_key: (u64, u64),
    dedup_idx: usize,
}

fn compute_local_track_dir(dedup_2d: &[Point2D], idx: usize) -> (f64, f64) {
    let n = dedup_2d.len();
    if n < 2 {
        return (-1.0, -1.0);
    }
    let init_bwd_dir = if idx > 0 {
        Some(get_direction(dedup_2d[idx - 1], dedup_2d[idx]))
    } else {
        None
    };
    let mut bwd = idx;
    let mut acc_bwd = 0.0;
    while bwd > 0 && acc_bwd < 20.0 {
        let seg_d = distance(dedup_2d[bwd - 1], dedup_2d[bwd]);
        if bwd < idx && seg_d >= 2.0 {
            if let Some(d0) = init_bwd_dir {
                let d_cur = get_direction(dedup_2d[bwd - 1], dedup_2d[bwd]);
                if get_difference_from_direction(d0, d_cur) > 35.0 {
                    break;
                }
            }
        }
        acc_bwd += seg_d;
        bwd -= 1;
    }

    let init_fwd_dir = if idx + 1 < n {
        Some(get_direction(dedup_2d[idx], dedup_2d[idx + 1]))
    } else {
        None
    };
    let mut fwd = idx;
    let mut acc_fwd = 0.0;
    while fwd + 1 < n && acc_fwd < 20.0 {
        let seg_d = distance(dedup_2d[fwd], dedup_2d[fwd + 1]);
        if fwd > idx && seg_d >= 2.0 {
            if let Some(d0) = init_fwd_dir {
                let d_cur = get_direction(dedup_2d[fwd], dedup_2d[fwd + 1]);
                if get_difference_from_direction(d0, d_cur) > 35.0 {
                    break;
                }
            }
        }
        acc_fwd += seg_d;
        fwd += 1;
    }

    let in_dir = if bwd < idx && distance(dedup_2d[bwd], dedup_2d[idx]) >= 1.5 {
        get_direction(dedup_2d[bwd], dedup_2d[idx])
    } else {
        -1.0
    };
    let out_dir = if fwd > idx && distance(dedup_2d[idx], dedup_2d[fwd]) >= 1.5 {
        get_direction(dedup_2d[idx], dedup_2d[fwd])
    } else {
        -1.0
    };
    match (in_dir >= 0.0, out_dir >= 0.0) {
        (true, true) => (in_dir, out_dir),
        (true, false) => (in_dir, in_dir),
        (false, true) => (out_dir, out_dir),
        (false, false) => (-1.0, -1.0),
    }
}

/// Snaps a GPS point `(lon_deg, lat_deg)` with local travel bearings `track_dirs`
/// to the best matching road edge within `max_distance_meters`, penalizing sidewalks/footways,
/// wrong-way one-way carriageways, and perpendicular side-street stubs.
#[allow(clippy::too_many_arguments)]
fn snap_track_point_to_road(
    graph: &mut GraphRef<'_>,
    lon_deg: f64,
    lat_deg: f64,
    max_distance_meters: f64,
    track_dirs: (f64, f64),
    is_endpoint: bool,
    dedup_idx: usize,
    evaluator: &mut ProfileEvaluator,
    lookups: &LookupData,
) -> Option<SnappedCandidate> {
    let wp_lon = lon_to_ilon(lon_deg);
    let wp_lat = lat_to_ilat(lat_deg);
    let scales = spatial::get_lon_lat_to_meter_scales(wp_lat);
    let dlon2m = scales[0];
    let dlat2m = scales[1];
    let max_dlon = (max_distance_meters / dlon2m).ceil() as i32 + 500;
    let max_dlat = (max_distance_meters / dlat2m).ceil() as i32 + 500;
    let min_lon = wp_lon - max_dlon;
    let max_lon = wp_lon + max_dlon;
    let min_lat = wp_lat - max_dlat;
    let max_lat = wp_lat + max_dlat;

    let grid_cell_size = crate::graph::routing_graph::GRID_CELL_SIZE;
    let min_cx = (min_lon - 20000).div_euclid(grid_cell_size);
    let max_cx = (max_lon + 20000).div_euclid(grid_cell_size);
    let min_cy = (min_lat - 20000).div_euclid(grid_cell_size);
    let max_cy = (max_lat + 20000).div_euclid(grid_cell_size);

    if let Some(g_mut) = graph.as_mut() {
        if g_mut.has_cell_provider() {
            g_mut.ensure_bbox_cells_loaded(
                min_cx * grid_cell_size,
                min_cy * grid_cell_size,
                (max_cx + 1) * grid_cell_size,
                (max_cy + 1) * grid_cell_size,
            );
            g_mut.ensure_external_link_cells_for_grid(min_cx, max_cx, min_cy, max_cy);
        }
    }

    let mut candidate_nodes: Vec<u64> = Vec::new();
    if !graph.spatial_grid.is_empty() {
        for cx in min_cx..=max_cx {
            for cy in min_cy..=max_cy {
                if let Some(nodes) = graph.spatial_grid.get(&(cx, cy)) {
                    candidate_nodes.extend_from_slice(nodes);
                }
            }
        }
    }

    let node_iter: Box<dyn Iterator<Item = u64> + '_> = if !candidate_nodes.is_empty() {
        Box::new(candidate_nodes.into_iter())
    } else if graph.is_resolved {
        Box::new(graph.node_edge_offsets.keys().copied())
    } else {
        Box::new(graph.edges.keys().copied())
    };

    let mut way_lookup_buf = vec![0i32; lookups.way.names.len()];
    let mut poly: Vec<crate::types::Point3D> = Vec::with_capacity(32);

    let mut best_score = f64::INFINITY;
    let mut best_cand: Option<(SnappedCandidate, u64, u64)> = None;

    for s_id in node_iter {
        let s_pos = crate::graph::node::unpack_node_id(s_id);
        if s_pos.lon < min_lon - 50000
            || s_pos.lon > max_lon + 50000
            || s_pos.lat < min_lat - 50000
            || s_pos.lat > max_lat + 50000
        {
            continue;
        }
        let Some(source_node) = graph.nodes.get(&s_id) else {
            continue;
        };
        let edge_vec = graph.get_edges(s_id);
        if edge_vec.is_empty() {
            continue;
        }

        for edge in edge_vec {
            let edge_min_lon = s_pos.lon.min(edge.target_lon);
            let edge_max_lon = s_pos.lon.max(edge.target_lon);
            let edge_min_lat = s_pos.lat.min(edge.target_lat);
            let edge_max_lat = s_pos.lat.max(edge.target_lat);
            let margin = if edge.geometry.is_empty() { 0 } else { 10000 };
            if edge_max_lon + margin < min_lon
                || edge_min_lon - margin > max_lon
                || edge_max_lat + margin < min_lat
                || edge_min_lat - margin > max_lat
            {
                continue;
            }
            let Some(desc_bytes) = edge.description(graph) else {
                continue;
            };
            let t_elev = if edge.target_selev != i16::MIN {
                edge.target_selev
            } else {
                graph
                    .nodes
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

            let mut evaluated_way: Option<crate::dsl::evaluator::WayCostResult> = None;

            for i in 0..poly.len() - 1 {
                let p1 = poly[i].to_2d();
                let p2 = poly[i + 1].to_2d();
                if p1.lon.max(p2.lon) < min_lon
                    || p1.lon.min(p2.lon) > max_lon
                    || p1.lat.max(p2.lat) < min_lat
                    || p1.lat.min(p2.lat) > max_lat
                {
                    continue;
                }

                let dx = (p2.lon - p1.lon) as f64 * dlon2m;
                let dy = (p2.lat - p1.lat) as f64 * dlat2m;
                let seg_len = (dx * dx + dy * dy).sqrt();
                if seg_len <= 1e-3 {
                    continue;
                }

                let px = (wp_lon - p1.lon) as f64 * dlon2m;
                let py = (wp_lat - p1.lat) as f64 * dlat2m;
                let raw_t = (px * dx + py * dy) / (seg_len * seg_len);
                let clamped_t = raw_t.clamp(0.0, 1.0);
                let proj_x = clamped_t * dx;
                let proj_y = clamped_t * dy;
                let dist_m = ((px - proj_x).powi(2) + (py - proj_y).powi(2)).sqrt();
                if dist_m > max_distance_meters || dist_m >= best_score {
                    continue;
                }

                let seg_dir = get_direction(p1, p2);
                let (in_dir, out_dir) = track_dirs;
                let dir_penalty = if in_dir >= 0.0 && out_dir >= 0.0 {
                    let diff_in = get_difference_from_direction(in_dir, seg_dir);
                    let diff_out = get_difference_from_direction(out_dir, seg_dir);
                    let turn_angle = get_difference_from_direction(in_dir, out_dir);
                    let (angle_diff, arm_penalty) = if !is_endpoint && turn_angle > 30.0 {
                        if diff_in + 5.0 < diff_out {
                            // Incoming arm should end near the turn, not start at the turn and continue past it
                            let arm_p = if clamped_t * seg_len < 12.0
                                && (1.0 - clamped_t) * seg_len > 8.0
                            {
                                25.0
                            } else {
                                0.0
                            };
                            (diff_in, arm_p)
                        } else if diff_out + 5.0 < diff_in {
                            // Outgoing arm should start near the turn, not end at the turn from the opposite side
                            let arm_p = if (1.0 - clamped_t) * seg_len < 12.0
                                && clamped_t * seg_len > 8.0
                            {
                                25.0
                            } else {
                                0.0
                            };
                            (diff_out, arm_p)
                        } else {
                            (diff_in.min(diff_out), 0.0)
                        }
                    } else {
                        (diff_in.min(diff_out), 0.0)
                    };
                    let base_p = if is_endpoint {
                        angle_diff * 0.005
                    } else if angle_diff > 105.0 {
                        80.0 + (angle_diff - 105.0) * 0.5
                    } else if angle_diff > 55.0 {
                        (angle_diff - 55.0) * 0.6
                    } else {
                        0.0
                    };
                    base_p + arm_penalty
                } else {
                    0.0
                };
                if dist_m + dir_penalty >= best_score {
                    continue;
                }

                if evaluated_way.is_none() {
                    lookups
                        .way
                        .decode_into(&mut way_lookup_buf, edge.is_reverse, desc_bytes);
                    if dedup_idx == 0
                        && !evaluator.profile.check_start_way_decoded(&way_lookup_buf)
                    {
                        break;
                    }
                    let w = evaluator.evaluate_way(&way_lookup_buf);
                    if w.costfactor >= 9999.0 {
                        break;
                    }
                    if !graph.is_connected_passable_edge(
                        s_id,
                        edge.target_id,
                        6,
                        evaluator,
                        lookups,
                        &mut way_lookup_buf,
                    ) {
                        break;
                    }
                    evaluated_way = Some(w);
                }
                let wc = evaluated_way.as_ref().unwrap();

                let oneway_penalty = if is_endpoint {
                    0.0
                } else if (wc.classifiermask & 1) != 0 {
                    60.0
                } else {
                    0.0
                };

                let footway_penalty = if is_endpoint {
                    0.0
                } else if wc.priorityclassifier <= 4 && wc.costfactor >= 4.5 {
                    14.0
                } else if wc.priorityclassifier <= 6 && wc.costfactor >= 2.5 {
                    4.0
                } else {
                    0.0
                };

                let score = dist_m + dir_penalty + oneway_penalty + footway_penalty;
                if score < best_score {
                    best_score = score;
                    // For interior control points, keep the crosspoint slightly inside the segment
                    // so subsequent A* waypoint snapping does not land on a multi-way junction node.
                    let safe_t = if is_endpoint {
                        clamped_t
                    } else if seg_len >= 7.0 {
                        let margin_t = (3.0 / seg_len).min(0.45);
                        clamped_t.clamp(margin_t, 1.0 - margin_t)
                    } else {
                        0.5
                    };
                    let snap_ilon = p1.lon + ((p2.lon - p1.lon) as f64 * safe_t).round() as i32;
                    let snap_ilat = p1.lat + ((p2.lat - p1.lat) as f64 * safe_t).round() as i32;
                    let snap_lon = spatial::ilon_to_lon(snap_ilon);
                    let snap_lat = spatial::ilat_to_lat(snap_ilat);
                    let id1 = s_id;
                    let id2 = edge.target_id;
                    let edge_key = if id1 <= id2 { (id1, id2) } else { (id2, id1) };

                    best_cand = Some((
                        SnappedCandidate {
                            coord: (snap_lon, snap_lat),
                            edge_key,
                            dedup_idx,
                        },
                        id1,
                        id2,
                    ));
                }
            }
        }
    }

    if let Some((cand, id1, id2)) = best_cand {
        if let Some(g_mut) = graph.as_mut() {
            if g_mut.has_cell_provider() {
                g_mut.ensure_node_finalized(id1);
                g_mut.ensure_node_finalized(id2);
            }
        }
        Some(cand)
    } else {
        None
    }
}

fn deduplicate_track_points(
    track_points: &[(f64, f64)],
    min_spacing_m: f64,
) -> (Vec<(f64, f64)>, Vec<Point2D>) {
    let mut dedup: Vec<(f64, f64)> = Vec::with_capacity(track_points.len());
    let mut dedup_2d: Vec<Point2D> = Vec::with_capacity(track_points.len());
    for (i, &(lon, lat)) in track_points.iter().enumerate() {
        let pt = Point2D::new(lon_to_ilon(lon), lat_to_ilat(lat));
        let is_last = i == track_points.len() - 1;
        if let Some(&prev_pt) = dedup_2d.last() {
            let d = distance(prev_pt, pt);
            if d < min_spacing_m && !is_last {
                continue;
            }
        }
        dedup.push((lon, lat));
        dedup_2d.push(pt);
    }
    if dedup.len() < 2 {
        dedup = vec![track_points[0], *track_points.last().unwrap()];
        dedup_2d = dedup
            .iter()
            .map(|&(lon, lat)| Point2D::new(lon_to_ilon(lon), lat_to_ilat(lat)))
            .collect();
    }
    (dedup, dedup_2d)
}

fn extract_snapped_candidates_ref(
    dedup: &[(f64, f64)],
    dedup_2d: &[Point2D],
    graph: &mut GraphRef<'_>,
    lookups: &LookupData,
    profile: &Profile,
    options: &MapMatchOptions,
) -> Result<Vec<SnappedCandidate>, String> {
    let n = dedup.len();
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[n - 1] = true;
    if options.rdp_tolerance_m > 0.0 {
        rdp_keep_recursive(dedup_2d, 0, n - 1, options.rdp_tolerance_m, &mut keep);
    } else {
        keep.fill(true);
    }

    if options.sample_step_m > 0.0 {
        let mut acc_dist = 0.0f64;
        for i in 1..n {
            acc_dist += distance(dedup_2d[i - 1], dedup_2d[i]);
            if keep[i] {
                acc_dist = 0.0;
            } else if acc_dist >= options.sample_step_m {
                keep[i] = true;
                acc_dist = 0.0;
            }
        }
    }

    let cand_indices: Vec<usize> = (0..n).filter(|&i| keep[i]).collect();
    let mut evaluator = ProfileEvaluator::new(profile, &lookups.way, &lookups.node);
    let mut snapped_list: Vec<SnappedCandidate> = Vec::with_capacity(cand_indices.len());

    for (c_pos, &idx) in cand_indices.iter().enumerate() {
        let (lon, lat) = dedup[idx];
        let is_endpoint = c_pos == 0 || c_pos == cand_indices.len() - 1;
        let track_dir = compute_local_track_dir(dedup_2d, idx);
        if let Some(sc) = snap_track_point_to_road(
            graph,
            lon,
            lat,
            options.max_snap_distance_m,
            track_dir,
            is_endpoint,
            idx,
            &mut evaluator,
            lookups,
        ) {
            snapped_list.push(sc);
        }
    }

    if snapped_list.len() < 2 {
        return Err(
            "Fewer than 2 track points snapped to accessible roads within max_snap_distance_m"
                .to_string(),
        );
    }

    let mut filtered: Vec<SnappedCandidate> = Vec::with_capacity(snapped_list.len());
    let mut last_edge_key: Option<(u64, u64)> = None;

    for i in 0..snapped_list.len() {
        let cur = &snapped_list[i];
        let is_endpoint = i == 0 || i == snapped_list.len() - 1;
        if !is_endpoint
            && last_edge_key == Some(cur.edge_key)
            && snapped_list[i + 1].edge_key == cur.edge_key
        {
            continue;
        }
        filtered.push(cur.clone());
        last_edge_key = Some(cur.edge_key);
    }

    if filtered.len() < 2 {
        filtered = vec![
            snapped_list.first().unwrap().clone(),
            snapped_list.last().unwrap().clone(),
        ];
    }

    Ok(filtered)
}

fn extract_control_waypoints_ref(
    track_points: &[(f64, f64)],
    graph: &mut GraphRef<'_>,
    lookups: &LookupData,
    profile: &Profile,
    options: &MapMatchOptions,
) -> Result<Vec<(f64, f64)>, String> {
    if track_points.len() < 2 {
        return Err("At least 2 GPS track points are required for map-matching".to_string());
    }
    let (dedup, dedup_2d) = deduplicate_track_points(track_points, options.min_point_spacing_m);
    let filtered =
        extract_snapped_candidates_ref(&dedup, &dedup_2d, graph, lookups, profile, options)?;
    Ok(filtered.into_iter().map(|c| c.coord).collect())
}

impl AStarRouter {
    /// Snaps a recorded GPX XML track to the routing graph network and returns the matched `RouteResult`.
    pub fn match_gpx_track(
        &self,
        graph: &RoutingGraph,
        lookups: &LookupData,
        profile: &Profile,
        gpx_xml: &str,
        options: &MapMatchOptions,
    ) -> Result<RouteResult, String> {
        let track_points = parse_gpx_points(gpx_xml)?;
        self.match_track_points(graph, lookups, profile, &track_points, options)
    }

    /// Snaps a recorded GPX XML track using lazy on-demand cell loading.
    pub fn match_gpx_track_lazy(
        &self,
        graph: &mut RoutingGraph,
        lookups: &LookupData,
        profile: &Profile,
        gpx_xml: &str,
        options: &MapMatchOptions,
    ) -> Result<RouteResult, String> {
        let track_points = parse_gpx_points(gpx_xml)?;
        let mut graph_ref = GraphRef::Mutable(graph);
        self.match_track_points_ref(&mut graph_ref, lookups, profile, &track_points, options)
    }

    /// Snaps a sequence of recorded `(lon, lat)` GPS coordinates to the routing graph network.
    pub fn match_track_points(
        &self,
        graph: &RoutingGraph,
        lookups: &LookupData,
        profile: &Profile,
        track_points: &[(f64, f64)],
        options: &MapMatchOptions,
    ) -> Result<RouteResult, String> {
        let mut graph_ref = GraphRef::Shared(graph);
        self.match_track_points_ref(&mut graph_ref, lookups, profile, track_points, options)
    }

    #[allow(clippy::too_many_arguments)]
    fn route_control_span_adaptive(
        &self,
        graph: &mut GraphRef<'_>,
        lookups: &LookupData,
        profile: &Profile,
        dedup: &[(f64, f64)],
        dedup_2d: &[Point2D],
        start_cand: &SnappedCandidate,
        end_cand: &SnappedCandidate,
        options: &MapMatchOptions,
        timode: i32,
        depth: usize,
        out_legs: &mut Vec<RouteResult>,
    ) -> bool {
        if let Ok(leg) = self.find_route_leg_ref(
            graph,
            lookups,
            profile,
            start_cand.coord,
            end_cand.coord,
            0,
            &[],
            None,
            false,
            timode,
        ) {
            let tol = options.deviation_tolerance_m.max(15.0) * 1.4;
            let mut needs_split = false;
            if depth < 4 && end_cand.dedup_idx > start_cand.dedup_idx + 1 {
                let leg_2d: Vec<Point2D> = leg
                    .points
                    .iter()
                    .map(|p| Point2D::new(lon_to_ilon(p.lon), lat_to_ilat(p.lat)))
                    .collect();
                let gps_slice = &dedup_2d[start_cand.dedup_idx..=end_cand.dedup_idx];
                for &pt in gps_slice {
                    if min_dist_to_polyline_m(pt, &leg_2d) > tol {
                        needs_split = true;
                        break;
                    }
                }
                if !needs_split {
                    for &lp in &leg_2d {
                        if min_dist_to_polyline_m(lp, gps_slice) > tol {
                            needs_split = true;
                            break;
                        }
                    }
                }
            }

            if needs_split {
                let mid_idx = (start_cand.dedup_idx + end_cand.dedup_idx) / 2;
                let (lon, lat) = dedup[mid_idx];
                let track_dir = compute_local_track_dir(dedup_2d, mid_idx);
                let mut evaluator = ProfileEvaluator::new(profile, &lookups.way, &lookups.node);
                if let Some(mid_cand) = snap_track_point_to_road(
                    graph,
                    lon,
                    lat,
                    options.max_snap_distance_m,
                    track_dir,
                    false,
                    mid_idx,
                    &mut evaluator,
                    lookups,
                ) {
                    let prev_len = out_legs.len();
                    if self.route_control_span_adaptive(
                        graph,
                        lookups,
                        profile,
                        dedup,
                        dedup_2d,
                        start_cand,
                        &mid_cand,
                        options,
                        timode,
                        depth + 1,
                        out_legs,
                    ) && self.route_control_span_adaptive(
                        graph,
                        lookups,
                        profile,
                        dedup,
                        dedup_2d,
                        &mid_cand,
                        end_cand,
                        options,
                        timode,
                        depth + 1,
                        out_legs,
                    ) {
                        return true;
                    }
                    out_legs.truncate(prev_len);
                }
            }

            out_legs.push(leg);
            return true;
        }
        false
    }

    fn match_track_points_ref(
        &self,
        graph: &mut GraphRef<'_>,
        lookups: &LookupData,
        profile: &Profile,
        track_points: &[(f64, f64)],
        options: &MapMatchOptions,
    ) -> Result<RouteResult, String> {
        if track_points.len() < 2 {
            return Err("At least 2 GPS track points are required for map-matching".to_string());
        }
        let (dedup, dedup_2d) = deduplicate_track_points(track_points, options.min_point_spacing_m);
        let control_cands =
            extract_snapped_candidates_ref(&dedup, &dedup_2d, graph, lookups, profile, options)?;
        let timode = options
            .turn_instruction_mode
            .unwrap_or_else(|| profile.get_global_var("turnInstructionMode", 0.0) as i32);
        let kinematic_cfg = KinematicConfig::from_profile(profile);

        let mut legs = Vec::with_capacity(control_cands.len());
        let mut curr_idx = 0usize;
        while curr_idx + 1 < control_cands.len() {
            let mut next_idx = curr_idx + 1;
            let mut matched = false;
            while next_idx < control_cands.len() {
                if self.route_control_span_adaptive(
                    graph,
                    lookups,
                    profile,
                    &dedup,
                    &dedup_2d,
                    &control_cands[curr_idx],
                    &control_cands[next_idx],
                    options,
                    timode,
                    0,
                    &mut legs,
                ) {
                    matched = true;
                    break;
                }
                next_idx += 1;
            }
            if matched {
                curr_idx = next_idx;
            } else {
                return Err(format!(
                    "Failed to map-match track segment starting at waypoint {}",
                    curr_idx
                ));
            }
        }

        let mut merged =
            RouteResult::merge_with_via_correction(legs, options.via_correction_max_dist_m)?;
        merged.turn_instruction_mode = timode;
        merged.recalc_track(graph, &kinematic_cfg);
        Ok(merged)
    }

    /// Snaps a GPX XML track to the road network and extracts the minimal sequence of
    /// `(lon, lat)` waypoints needed for `profile` to reproduce the track within `options.deviation_tolerance_m`.
    pub fn match_gpx_with_minimal_waypoints(
        &self,
        graph: &RoutingGraph,
        lookups: &LookupData,
        profile: &Profile,
        gpx_xml: &str,
        options: &MapMatchOptions,
    ) -> Result<(Vec<(f64, f64)>, RouteResult), String> {
        let track_points = parse_gpx_points(gpx_xml)?;
        self.match_track_with_minimal_waypoints(graph, lookups, profile, &track_points, options)
    }

    /// Snaps a GPX XML track and extracts minimal waypoints using lazy on-demand cell loading.
    pub fn match_gpx_with_minimal_waypoints_lazy(
        &self,
        graph: &mut RoutingGraph,
        lookups: &LookupData,
        profile: &Profile,
        gpx_xml: &str,
        options: &MapMatchOptions,
    ) -> Result<(Vec<(f64, f64)>, RouteResult), String> {
        let track_points = parse_gpx_points(gpx_xml)?;
        let mut graph_ref = GraphRef::Mutable(graph);
        self.match_track_with_minimal_waypoints_ref(
            &mut graph_ref,
            lookups,
            profile,
            &track_points,
            options,
        )
    }

    /// Snaps a coordinate sequence to the road network and extracts the minimal sequence of
    /// `(lon, lat)` waypoints needed for `profile` to reproduce the track within `options.deviation_tolerance_m`.
    pub fn match_track_with_minimal_waypoints(
        &self,
        graph: &RoutingGraph,
        lookups: &LookupData,
        profile: &Profile,
        track_points: &[(f64, f64)],
        options: &MapMatchOptions,
    ) -> Result<(Vec<(f64, f64)>, RouteResult), String> {
        let mut graph_ref = GraphRef::Shared(graph);
        self.match_track_with_minimal_waypoints_ref(
            &mut graph_ref,
            lookups,
            profile,
            track_points,
            options,
        )
    }

    fn match_track_with_minimal_waypoints_ref(
        &self,
        graph: &mut GraphRef<'_>,
        lookups: &LookupData,
        profile: &Profile,
        track_points: &[(f64, f64)],
        options: &MapMatchOptions,
    ) -> Result<(Vec<(f64, f64)>, RouteResult), String> {
        let ref_route =
            self.match_track_points_ref(graph, lookups, profile, track_points, options)?;
        if ref_route.points.len() < 2 {
            return Err("Map-matched reference route has fewer than 2 points".to_string());
        }

        let m = ref_route.points.len() - 1;
        let ref_2d: Vec<Point2D> = ref_route
            .points
            .iter()
            .map(|p| Point2D::new(lon_to_ilon(p.lon), lat_to_ilat(p.lat)))
            .collect();

        let mut cum_dist = Vec::with_capacity(m + 1);
        cum_dist.push(0.0f64);
        for i in 1..=m {
            let d = distance(ref_2d[i - 1], ref_2d[i]);
            cum_dist.push(cum_dist[i - 1] + d);
        }

        // For interior indices, nudge up to 3.5m into the longer adjacent segment so the waypoint
        // lies strictly inside a road edge rather than on a multi-way junction node, without
        // drifting far from `ref_route.points[idx]`.
        let wp_coord = |idx: usize| -> (f64, f64) {
            if idx == 0 {
                return (ref_route.points[0].lon, ref_route.points[0].lat);
            }
            if idx >= m {
                return (ref_route.points[m].lon, ref_route.points[m].lat);
            }
            let len_prev = distance(ref_2d[idx - 1], ref_2d[idx]);
            let len_next = distance(ref_2d[idx], ref_2d[idx + 1]);
            let (other_idx, seg_len) = if len_next >= len_prev {
                (idx + 1, len_next)
            } else {
                (idx - 1, len_prev)
            };
            if seg_len >= 4.0 {
                let frac = (3.5 / seg_len).min(0.5);
                let lon = ref_route.points[idx].lon
                    + (ref_route.points[other_idx].lon - ref_route.points[idx].lon) * frac;
                let lat = ref_route.points[idx].lat
                    + (ref_route.points[other_idx].lat - ref_route.points[idx].lat) * frac;
                (lon, lat)
            } else {
                (ref_route.points[idx].lon, ref_route.points[idx].lat)
            }
        };

        let tol_m = options.deviation_tolerance_m.max(5.0);
        let timode = options
            .turn_instruction_mode
            .unwrap_or_else(|| profile.get_global_var("turnInstructionMode", 0.0) as i32);

        let mut keep = vec![false; m + 1];
        keep[0] = true;
        keep[m] = true;

        let max_initial_span_m = 3500.0;
        let mut last_seed_dist = 0.0;
        for i in 1..m {
            if cum_dist[i] - last_seed_dist >= max_initial_span_m
                && cum_dist[m] - cum_dist[i] >= max_initial_span_m * 0.5
            {
                keep[i] = true;
                last_seed_dist = cum_dist[i];
            }
        }
        let seed_indices: Vec<usize> = (0..=m).filter(|&i| keep[i]).collect();
        let mut stack: Vec<(usize, usize)> = seed_indices
            .windows(2)
            .rev()
            .map(|w| (w[0], w[1]))
            .collect();
        while let Some((start_idx, end_idx)) = stack.pop() {
            if end_idx <= start_idx + 1 || cum_dist[end_idx] - cum_dist[start_idx] < tol_m * 2.0 {
                continue;
            }
            let start_c = wp_coord(start_idx);
            let end_c = wp_coord(end_idx);

            let routed = self.find_route_leg_ref(
                graph, lookups, profile, start_c, end_c, 0, &[], None, false, timode,
            );

            match routed {
                Ok(leg) => {
                    if let Some(split_k) = find_worst_deviation_index(
                        &ref_2d,
                        &cum_dist,
                        start_idx,
                        end_idx,
                        &leg,
                        tol_m,
                    ) {
                        keep[split_k] = true;
                        stack.push((split_k, end_idx));
                        stack.push((start_idx, split_k));
                    }
                }
                Err(_) => {
                    let target_d = (cum_dist[start_idx] + cum_dist[end_idx]) * 0.5;
                    if let Some(mid_k) = ((start_idx + 1)..end_idx).min_by(|&a, &b| {
                        (cum_dist[a] - target_d)
                            .abs()
                            .total_cmp(&(cum_dist[b] - target_d).abs())
                    }) {
                        if cum_dist[mid_k] - cum_dist[start_idx] >= tol_m
                            && cum_dist[end_idx] - cum_dist[mid_k] >= tol_m
                        {
                            keep[mid_k] = true;
                            stack.push((mid_k, end_idx));
                            stack.push((start_idx, mid_k));
                        }
                    }
                }
            }
        }

        // Redundancy pruning pass: drop any interior via point whose removal still keeps the
        // bridged leg within `tol_m` of the reference route.
        let mut kept: Vec<usize> = (0..=m).filter(|&i| keep[i]).collect();
        let mut i = 1usize;
        while i + 1 < kept.len() {
            let prev_idx = kept[i - 1];
            let next_idx = kept[i + 1];
            let bridged = self.find_route_leg_ref(
                graph,
                lookups,
                profile,
                wp_coord(prev_idx),
                wp_coord(next_idx),
                0,
                &[],
                None,
                false,
                timode,
            );
            let can_drop = match bridged {
                Ok(leg) => find_worst_deviation_index(
                    &ref_2d, &cum_dist, prev_idx, next_idx, &leg, tol_m,
                )
                .is_none(),
                Err(_) => false,
            };
            if can_drop {
                kept.remove(i);
            } else {
                i += 1;
            }
        }

        let waypoints: Vec<(f64, f64)> = kept.iter().map(|&idx| wp_coord(idx)).collect();
        let final_route = self.find_multi_route_with_options_ref(
            graph,
            lookups,
            profile,
            &waypoints,
            &super::search::RoutingOptions::default(),
        )?;

        Ok((waypoints, final_route))
    }
}

fn min_dist_to_polyline_m(pt: Point2D, poly: &[Point2D]) -> f64 {
    if poly.is_empty() {
        return f64::INFINITY;
    }
    if poly.len() == 1 {
        return distance(pt, poly[0]);
    }
    let mut best = f64::INFINITY;
    for seg in poly.windows(2) {
        let d = perpendicular_distance_m(pt, seg[0], seg[1]);
        if d < best {
            best = d;
        }
    }
    best
}

/// Returns an interior reference index `k` in `(start_idx + 1)..end_idx` to split at when
/// either `ref -> leg` or `leg -> ref` exceeds `tol_m`.
fn find_worst_deviation_index(
    ref_2d: &[Point2D],
    cum_dist: &[f64],
    start_idx: usize,
    end_idx: usize,
    leg: &RouteResult,
    tol_m: f64,
) -> Option<usize> {
    if end_idx <= start_idx + 1 {
        return None;
    }
    let leg_2d: Vec<Point2D> = leg
        .points
        .iter()
        .map(|p| Point2D::new(lon_to_ilon(p.lon), lat_to_ilat(p.lat)))
        .collect();
    if leg_2d.is_empty() {
        return None;
    }

    struct Excursion {
        start_k: usize,
        end_k: usize,
        peak_k: usize,
        peak_dev: f64,
    }

    let mut excursions: Vec<Excursion> = Vec::new();
    let mut cur_exc: Option<Excursion> = None;

    for k in (start_idx + 1)..end_idx {
        if cum_dist[k] - cum_dist[start_idx] < tol_m || cum_dist[end_idx] - cum_dist[k] < tol_m {
            continue;
        }
        let d = min_dist_to_polyline_m(ref_2d[k], &leg_2d);
        if d > tol_m {
            match &mut cur_exc {
                Some(exc) => {
                    exc.end_k = k;
                    if d > exc.peak_dev {
                        exc.peak_dev = d;
                        exc.peak_k = k;
                    }
                }
                None => {
                    cur_exc = Some(Excursion {
                        start_k: k,
                        end_k: k,
                        peak_k: k,
                        peak_dev: d,
                    });
                }
            }
        } else if let Some(exc) = cur_exc.take() {
            excursions.push(exc);
        }
    }
    if let Some(exc) = cur_exc.take() {
        excursions.push(exc);
    }

    if !excursions.is_empty() {
        let first = &excursions[0];
        // If a long prefix (> 1.5 km) already follows `leg` within `tol_m`, isolate it first
        // so we do not re-run long-distance A* searches over the matched prefix.
        if cum_dist[first.start_k] - cum_dist[start_idx] > 1500.0
            && cum_dist[end_idx] - cum_dist[first.start_k] > tol_m * 4.0
        {
            let target_anchor_d = (cum_dist[first.start_k] - 40.0).max(cum_dist[start_idx] + tol_m);
            if let Some(anchor_k) = ((start_idx + 1)..=first.start_k)
                .filter(|&k| {
                    cum_dist[k] - cum_dist[start_idx] >= tol_m
                        && cum_dist[end_idx] - cum_dist[k] >= tol_m
                })
                .min_by(|&a, &b| {
                    (cum_dist[a] - target_anchor_d)
                        .abs()
                        .total_cmp(&(cum_dist[b] - target_anchor_d).abs())
                })
            {
                return Some(anchor_k);
            }
        }

        let worst_exc = excursions
            .iter()
            .max_by(|a, b| a.peak_dev.total_cmp(&b.peak_dev))
            .unwrap();
        let exc_len = cum_dist[worst_exc.end_k] - cum_dist[worst_exc.start_k];
        if exc_len > 400.0 && worst_exc.end_k > worst_exc.start_k + 2 {
            // For long corridor divergences, split near the middle [25%, 75%] of the excursion
            // to achieve balanced O(log N) subdivision instead of peeling one block at a time.
            let d_low = cum_dist[worst_exc.start_k] + exc_len * 0.25;
            let d_high = cum_dist[worst_exc.start_k] + exc_len * 0.75;
            let d_mid = cum_dist[worst_exc.start_k] + exc_len * 0.50;
            if let Some(mid_k) = (worst_exc.start_k..=worst_exc.end_k)
                .filter(|&k| cum_dist[k] >= d_low && cum_dist[k] <= d_high)
                .min_by(|&a, &b| {
                    (cum_dist[a] - d_mid)
                        .abs()
                        .total_cmp(&(cum_dist[b] - d_mid).abs())
                })
            {
                return Some(mid_k);
            }
        }
        return Some(worst_exc.peak_k);
    }

    // Also verify the routed leg did not take a detour away from a straight reference segment
    let ref_slice = &ref_2d[start_idx..=end_idx];
    let mut max_leg_dev = 0.0f64;
    let mut worst_lp = None;
    for &lp in &leg_2d {
        let d = min_dist_to_polyline_m(lp, ref_slice);
        if d > max_leg_dev {
            max_leg_dev = d;
            worst_lp = Some(lp);
        }
    }
    if max_leg_dev > tol_m {
        if let Some(lp) = worst_lp {
            let mut best_k = None;
            let mut best_d = f64::INFINITY;
            for k in (start_idx + 1)..end_idx {
                if cum_dist[k] - cum_dist[start_idx] < tol_m
                    || cum_dist[end_idx] - cum_dist[k] < tol_m
                {
                    continue;
                }
                let d = distance(lp, ref_2d[k]);
                if d < best_d {
                    best_d = d;
                    best_k = Some(k);
                }
            }
            return best_k;
        }
    }

    None
}
