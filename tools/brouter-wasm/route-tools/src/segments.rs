//! Route segment classification and GeoJSON enrichment for surface, road type,
//! noise, traffic, and speed-limit breakdowns.

use brouter_rs::dsl::lookups::LookupData;
use brouter_rs::graph::{
    get_lon_lat_to_meter_scales, lat_to_ilat, lon_to_ilon, unpack_node_id, MatchedWaypoint,
    Point2D, Point3D, RoutingGraph, WaypointMatcher, GRID_CELL_SIZE,
};
use brouter_rs::routing::track::RouteResult;
use brouter_rs::types::Distance;

/// Decoded BRouter RD5 attributes for the road/path edge closest to a queried map point.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PointWayInfo {
    pub distance_m: f64,
    pub highway: String,
    pub surface: String,
    pub noise_class: u8,
    pub traffic_class: u8,
    pub maxspeed: u32,
    pub town_class: u8,
    pub lit: bool,
    pub sidewalk: bool,
}

/// Finds the road or path edge closest to `(lon_deg, lat_deg)` within `max_distance_m`
/// (lazily loading the local `1/80°` MicroCache cells if a `CellProvider` is attached)
/// and returns its decoded `highway`, `surface`, `estimated_noise_class`, `estimated_traffic_class`,
/// and `maxspeed`.
pub fn inspect_nearest_way(
    graph: &mut RoutingGraph,
    lookups: &LookupData,
    lon_deg: f64,
    lat_deg: f64,
    max_distance_m: f64,
) -> Option<PointWayInfo> {
    let wp_lon = lon_to_ilon(lon_deg);
    let wp_lat = lat_to_ilat(lat_deg);
    let scales = get_lon_lat_to_meter_scales(wp_lat);
    let max_dlon = (max_distance_m / scales[0]).ceil() as i32 + 500;
    let max_dlat = (max_distance_m / scales[1]).ceil() as i32 + 500;
    let mut min_lon = wp_lon - max_dlon;
    let mut max_lon = wp_lon + max_dlon;
    let mut min_lat = wp_lat - max_dlat;
    let mut max_lat = wp_lat + max_dlat;

    let min_cx = (min_lon - 20_000).div_euclid(GRID_CELL_SIZE);
    let max_cx = (max_lon + 20_000).div_euclid(GRID_CELL_SIZE);
    let min_cy = (min_lat - 20_000).div_euclid(GRID_CELL_SIZE);
    let max_cy = (max_lat + 20_000).div_euclid(GRID_CELL_SIZE);

    if graph.has_cell_provider() {
        graph.ensure_bbox_cells_loaded(
            min_cx * GRID_CELL_SIZE,
            min_cy * GRID_CELL_SIZE,
            (max_cx + 1) * GRID_CELL_SIZE,
            (max_cy + 1) * GRID_CELL_SIZE,
        );
        graph.ensure_external_link_cells_for_grid(min_cx, max_cx, min_cy, max_cy);
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

    let mut mwp = MatchedWaypoint::new("inspect", Point2D::new(wp_lon, wp_lat), max_distance_m);
    let mut best_desc: Option<(u32, bool)> = None;
    let mut poly: Vec<Point3D> = Vec::with_capacity(32);

    for s_id in node_iter {
        let s_pos = unpack_node_id(s_id);
        let s_ilon = s_pos.lon;
        let s_ilat = s_pos.lat;

        if s_ilon < min_lon - 50_000
            || s_ilon > max_lon + 50_000
            || s_ilat < min_lat - 50_000
            || s_ilat > max_lat + 50_000
        {
            continue;
        }

        let Some(source_node) = graph.nodes.get(&s_id) else {
            continue;
        };

        let edge_vec = graph.get_edges(s_id);
        for edge in edge_vec {
            let edge_min_lon = s_ilon.min(edge.target_lon);
            let edge_max_lon = s_ilon.max(edge.target_lon);
            let edge_min_lat = s_ilat.min(edge.target_lat);
            let edge_max_lat = s_ilat.max(edge.target_lat);

            let margin = if edge.is_geometry_empty() { 0 } else { 10_000 };
            if edge_max_lon + margin < min_lon
                || edge_min_lon - margin > max_lon
                || edge_max_lat + margin < min_lat
                || edge_min_lat - margin > max_lat
            {
                continue;
            }

            if edge.description(graph).is_none() {
                continue;
            }

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
                graph,
                &mut poly,
                source_node.ilon,
                source_node.ilat,
                source_node.selev,
                t_elev,
            );

            for i in 0..poly.len().saturating_sub(1) {
                let p1 = &poly[i];
                let p2 = &poly[i + 1];

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

                if WaypointMatcher::check_segment(
                    &mut mwp,
                    p1.to_2d(),
                    p2.to_2d(),
                    Point2D::new(source_node.ilon, source_node.ilat),
                    Point2D::new(edge.target_lon, edge.target_lat),
                ) {
                    best_desc = Some((edge.desc_id, edge.is_reverse));
                    let cur_dlon = (mwp.radius / scales[0]).ceil() as i32 + 50;
                    let cur_dlat = (mwp.radius / scales[1]).ceil() as i32 + 50;
                    min_lon = wp_lon - cur_dlon;
                    max_lon = wp_lon + cur_dlon;
                    min_lat = wp_lat - cur_dlat;
                    max_lat = wp_lat + cur_dlat;
                }
            }
        }
    }

    let (desc_id, is_reverse) = best_desc?;
    let desc_bytes = graph.descriptions.get(desc_id as usize)?.as_slice();
    let mut way_buf = vec![0i32; lookups.way.names.len()];
    lookups.way.decode_into(&mut way_buf, is_reverse, desc_bytes);
    let way_kv = lookups.way.format_key_values(&way_buf);
    let (surface, highway, noise_class, traffic_class, maxspeed, town_class, lit, sidewalk) =
        parse_way_tags(&way_kv);

    Some(PointWayInfo {
        distance_m: (mwp.radius * 10.0).round() / 10.0,
        highway,
        surface,
        noise_class,
        traffic_class,
        maxspeed,
        town_class,
        lit,
        sidewalk,
    })
}

/// A contiguous route segment with uniform surface and highway classifications.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct RouteSegment {
    pub from_dist_m: Distance,
    pub to_dist_m: Distance,
    pub surface: String,
    pub highway: String,
    pub noise_class: u8,
    pub traffic_class: u8,
    pub maxspeed: u32,
    pub costfactor: f32,
    pub town_class: u8,
    pub lit: bool,
    pub sidewalk: bool,
}

fn parse_way_tags(way_kv: &str) -> (String, String, u8, u8, u32, u8, bool, bool) {
    if way_kv == "directsegment" {
        return (String::new(), "beeline".to_string(), 0, 0, 0, 0, false, false);
    }

    let mut is_reverse = false;
    let mut surface = String::new();
    let mut highway = String::new();
    let mut noise: u8 = 0;
    let mut traffic: u8 = 0;
    let mut town: u8 = 0;
    let mut lit = false;
    let mut sidewalk = false;
    let mut maxspeed_fwd: Option<&str> = None;
    let mut maxspeed_bwd: Option<&str> = None;
    let mut maxspeed_base: Option<&str> = None;
    let mut zone_maxspeed: Option<&str> = None;

    for token in way_kv.split_whitespace() {
        let Some((k, v)) = token.split_once('=') else {
            continue;
        };
        match k {
            "reversedirection" => is_reverse = v == "yes",
            "surface" => surface = v.to_string(),
            "highway" => highway = v.to_string(),
            "estimated_noise_class" => noise = v.parse::<u8>().unwrap_or(0),
            "estimated_traffic_class" => traffic = v.parse::<u8>().unwrap_or(0),
            "estimated_town_class" => town = v.parse::<u8>().unwrap_or(0),
            "lit" => {
                lit = matches!(
                    v,
                    "yes" | "24/7" | "automatic" | "sunset-sunrise" | "dusk-dawn" | "limited"
                )
            }
            "sidewalk" => {
                if matches!(v, "both" | "right" | "left" | "separate" | "yes") {
                    sidewalk = true;
                }
            }
            "sidewalk:left" | "sidewalk:right" | "sidewalk:both" => {
                if matches!(v, "yes" | "separate" | "designated") {
                    sidewalk = true;
                }
            }
            "maxspeed:forward" => maxspeed_fwd = Some(v),
            "maxspeed:backward" => maxspeed_bwd = Some(v),
            "maxspeed" => maxspeed_base = Some(v),
            "zone:maxspeed" => zone_maxspeed = Some(v),
            _ => {}
        }
    }

    let dir_speed = if is_reverse { maxspeed_bwd } else { maxspeed_fwd };
    let speed_str = dir_speed.or(maxspeed_base).or(zone_maxspeed);
    let maxspeed = match speed_str {
        Some("urban") => 50,
        Some("rural") => 100,
        Some(s) => s
            .parse::<f32>()
            .ok()
            .map(|n| n.max(0.0) as u32)
            .unwrap_or(0),
        None => 0,
    };

    if traffic == 0
        && matches!(
            highway.as_str(),
            "trunk" | "trunk_link" | "motorway" | "motorway_link"
        )
    {
        traffic = 7;
    }

    (surface, highway, noise, traffic, maxspeed, town, lit, sidewalk)
}

/// Extracts merged `RouteSegment` intervals across `route` from its point distances and way messages.
pub fn extract_route_segments(route: &RouteResult) -> Vec<RouteSegment> {
    let mut segments: Vec<RouteSegment> = Vec::new();
    if route.points.len() < 2 {
        return segments;
    }

    for i in 1..route.points.len() {
        let from_dist = route.points[i - 1].distance_from_start_m;
        let to_dist = route.points[i].distance_from_start_m;
        if to_dist <= from_dist {
            continue;
        }
        let msg = route.messages.get(i).and_then(|m| m.as_ref());
        let way_kv = msg.map(|m| m.way_key_values.as_str()).unwrap_or("");
        let costfactor = msg
            .map(|m| (m.costfactor * 100.0).round() / 100.0)
            .unwrap_or(1.0);
        let (surface, highway, noise_class, traffic_class, maxspeed, town_class, lit, sidewalk) =
            parse_way_tags(way_kv);

        if let Some(last) = segments.last_mut() {
            if last.surface == surface
                && last.highway == highway
                && last.noise_class == noise_class
                && last.traffic_class == traffic_class
                && last.maxspeed == maxspeed
                && last.town_class == town_class
                && last.lit == lit
                && last.sidewalk == sidewalk
                && (last.costfactor - costfactor).abs() < 0.005
            {
                last.to_dist_m = to_dist;
                continue;
            }
        }
        segments.push(RouteSegment {
            from_dist_m: from_dist,
            to_dist_m: to_dist,
            surface,
            highway,
            noise_class,
            traffic_class,
            maxspeed,
            costfactor,
            town_class,
            lit,
            sidewalk,
        });
    }

    segments
}

/// Formats `route` as a BRouter GeoJSON FeatureCollection enriched with a `"segments"` array
/// inside `features[0].properties`.
pub fn to_geojson_with_segments(route: &RouteResult, profile_name: &str) -> String {
    let base_geojson = route.to_geojson(profile_name);
    let segments = extract_route_segments(route);

    let mut seg_json = String::new();
    for (i, seg) in segments.iter().enumerate() {
        if i > 0 {
            seg_json.push_str(",\n          ");
        }
        seg_json.push_str(&format!(
            r#"{{"from": {:.1}, "to": {:.1}, "surface": "{}", "highway": "{}", "noise": {}, "traffic": {}, "maxspeed": {}, "costfactor": {:.2}, "town": {}, "lit": {}, "sidewalk": {}}}"#,
            seg.from_dist_m,
            seg.to_dist_m,
            seg.surface,
            seg.highway,
            seg.noise_class,
            seg.traffic_class,
            seg.maxspeed,
            seg.costfactor,
            seg.town_class,
            seg.lit,
            seg.sidewalk
        ));
    }

    let target = "\n      },\n      \"geometry\": {";
    if let Some(pos) = base_geojson.find(target) {
        let mut out = String::with_capacity(base_geojson.len() + seg_json.len() + 64);
        out.push_str(&base_geojson[..pos]);
        out.push_str(",\n        \"segments\": [\n          ");
        out.push_str(&seg_json);
        out.push_str("\n        ]");
        out.push_str(&base_geojson[pos..]);
        out
    } else {
        base_geojson
    }
}
