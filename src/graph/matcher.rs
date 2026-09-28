//! Rust implementation corresponding to:
//! - Java class: `btools.mapaccess.MatchedWaypoint`
//! - Java source: `https://github.com/abrensch/brouter/blob/master/brouter-mapaccess/src/main/java/btools/mapaccess/MatchedWaypoint.java`
//! - Java class: `btools.mapaccess.WaypointMatcherImpl`
//! - Java source: `https://github.com/abrensch/brouter/blob/master/brouter-mapaccess/src/main/java/btools/mapaccess/WaypointMatcherImpl.java`
//!
//! # Summary
//! Projects input geographic waypoints onto nearest graph edges and computes
//! exact crosspoints, nearest node endpoints, and orthogonal projection distances.

use super::spatial;

/// A matched waypoint snapped to the nearest road segment in the graph.
#[derive(Debug, Clone, PartialEq)]
pub struct MatchedWaypoint {
    pub name: String,
    pub waypoint_lon: i32,
    pub waypoint_lat: i32,
    pub crosspoint_lon: i32,
    pub crosspoint_lat: i32,
    pub node1_lon: i32,
    pub node1_lat: i32,
    pub node2_lon: i32,
    pub node2_lat: i32,
    pub radius: f64,
}

impl MatchedWaypoint {
    pub fn new(name: &str, waypoint_lon: i32, waypoint_lat: i32, max_radius: f64) -> Self {
        Self {
            name: name.to_string(),
            waypoint_lon,
            waypoint_lat,
            crosspoint_lon: waypoint_lon,
            crosspoint_lat: waypoint_lat,
            node1_lon: waypoint_lon,
            node1_lat: waypoint_lat,
            node2_lon: waypoint_lon,
            node2_lat: waypoint_lat,
            radius: max_radius,
        }
    }
}

/// Snaps waypoints to road segment polylines.
pub struct WaypointMatcher {
    pub max_distance: f64,
}

impl WaypointMatcher {
    pub fn new(max_distance: f64) -> Self {
        Self { max_distance }
    }

    /// Evaluates a single polyline segment `(lon1, lat1)` -> `(lon2, lat2)`
    /// belonging to edge `(edge_start_lon, edge_start_lat)` -> `(edge_end_lon, edge_end_lat)`.
    ///
    /// Updates `mwp` if this segment is closer than previous candidates.
    pub fn check_segment(
        mwp: &mut MatchedWaypoint,
        lon1: i32,
        lat1: i32,
        lon2: i32,
        lat2: i32,
        edge_start_lon: i32,
        edge_start_lat: i32,
        edge_end_lon: i32,
        edge_end_lat: i32,
    ) {
        let scales = spatial::get_lon_lat_to_meter_scales((lat1 + lat2) >> 1);
        let dlon2m = scales[0];
        let dlat2m = scales[1];

        let dx = (lon2 - lon1) as f64 * dlon2m;
        let dy = (lat2 - lat1) as f64 * dlat2m;
        let d = (dy * dy + dx * dx).sqrt();

        if d == 0.0 {
            return;
        }

        let wp_lon = mwp.waypoint_lon;
        let wp_lat = mwp.waypoint_lat;
        let x1 = (lon1 - wp_lon) as f64 * dlon2m;
        let y1 = (lat1 - wp_lat) as f64 * dlat2m;
        let x2 = (lon2 - wp_lon) as f64 * dlon2m;
        let y2 = (lat2 - wp_lat) as f64 * dlat2m;
        let r12 = x1 * x1 + y1 * y1;
        let r22 = x2 * x2 + y2 * y2;

        let mut radius = if r12 < r22 {
            (y1 * dx - x1 * dy).abs() / d
        } else {
            (y2 * dx - x2 * dy).abs() / d
        };

        if radius <= mwp.radius {
            let mut s1 = x1 * dx + y1 * dy;
            let mut s2 = x2 * dx + y2 * dy;

            if s1 < 0.0 {
                s1 = -s1;
                s2 = -s2;
            }

            if s2 > 0.0 {
                radius = if s1 < s2 { r12.sqrt() } else { r22.sqrt() };
                if radius > mwp.radius {
                    return;
                }
            }

            mwp.radius = radius;
            mwp.node1_lon = edge_start_lon;
            mwp.node1_lat = edge_start_lat;
            mwp.node2_lon = edge_end_lon;
            mwp.node2_lat = edge_end_lat;

            if s2 < 0.0 {
                let wayfraction = -s2 / (d * d);
                let xm = x2 - wayfraction * dx;
                let ym = y2 - wayfraction * dy;
                mwp.crosspoint_lon = (xm / dlon2m).round() as i32 + wp_lon;
                mwp.crosspoint_lat = (ym / dlat2m).round() as i32 + wp_lat;
            } else if s1 > s2 {
                mwp.crosspoint_lon = lon2;
                mwp.crosspoint_lat = lat2;
            } else {
                mwp.crosspoint_lon = lon1;
                mwp.crosspoint_lat = lat1;
            }
        }
    }
}
