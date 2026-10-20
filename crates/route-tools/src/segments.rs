//! Route segment classification and GeoJSON enrichment for surface, road type,
//! noise, traffic, and speed-limit breakdowns.

use brouter_rs::routing::track::RouteResult;
use brouter_rs::types::Distance;

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
}

fn parse_way_tags(way_kv: &str) -> (String, String, u8, u8, u32) {
    if way_kv == "directsegment" {
        return (String::new(), "beeline".to_string(), 0, 0, 0);
    }

    let mut is_reverse = false;
    let mut surface = String::new();
    let mut highway = String::new();
    let mut noise: u8 = 0;
    let mut traffic: u8 = 0;
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

    (surface, highway, noise, traffic, maxspeed)
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
        let way_kv = route
            .messages
            .get(i)
            .and_then(|m| m.as_ref())
            .map(|m| m.way_key_values.as_str())
            .unwrap_or("");
        let (surface, highway, noise_class, traffic_class, maxspeed) = parse_way_tags(way_kv);

        if let Some(last) = segments.last_mut() {
            if last.surface == surface
                && last.highway == highway
                && last.noise_class == noise_class
                && last.traffic_class == traffic_class
                && last.maxspeed == maxspeed
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
            r#"{{"from": {:.1}, "to": {:.1}, "surface": "{}", "highway": "{}", "noise": {}, "traffic": {}, "maxspeed": {}}}"#,
            seg.from_dist_m,
            seg.to_dist_m,
            seg.surface,
            seg.highway,
            seg.noise_class,
            seg.traffic_class,
            seg.maxspeed
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
