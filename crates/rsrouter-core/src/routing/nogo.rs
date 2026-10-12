//! Rust implementation corresponding to BRouter no-go exclusion zones:
//! - Java source: `https://github.com/abrensch/brouter/blob/master/brouter-core/src/main/java/btools/router/OsmNodeNamed.java`
//! - Java source: `https://github.com/abrensch/brouter/blob/master/brouter-core/src/main/java/btools/router/RoutingContext.java`
//!
//! # Summary
//! Circular and weighted avoid areas for routing constraints.

use crate::graph::spatial::{distance, get_lon_lat_to_meter_scales, lat_to_ilat, lon_to_ilon};
use crate::types::{Point2D, Point3D};

/// A user-defined circular exclusion or avoid area.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct NogoArea {
    pub lon: f64,
    pub lat: f64,
    pub radius_m: f64,
    /// Penalty weight. If `None` or `< 0.0`, the area is an absolute exclusion zone.
    /// If `Some(w)` with `w >= 0.0`, traversal through the area incurs `distance_within_m * w` extra cost.
    pub weight: Option<f64>,
}

impl NogoArea {
    pub fn new(lon: f64, lat: f64, radius_m: f64) -> Self {
        Self {
            lon,
            lat,
            radius_m,
            weight: None,
        }
    }

    pub fn with_weight(lon: f64, lat: f64, radius_m: f64, weight: f64) -> Self {
        Self {
            lon,
            lat,
            radius_m,
            weight: Some(weight),
        }
    }

    #[inline]
    pub fn is_hard(&self) -> bool {
        match self.weight {
            None => true,
            Some(w) => w < 0.0 || w.is_nan(),
        }
    }
}

/// Precomputed internal representation of a no-go area with bounding box in microdegrees.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct InternalNogo {
    pub ilon: i32,
    pub ilat: i32,
    pub radius_m: f64,
    pub weight: Option<f64>,
    pub min_lon: i32,
    pub max_lon: i32,
    pub min_lat: i32,
    pub max_lat: i32,
}

impl InternalNogo {
    pub fn from_area(area: &NogoArea) -> Self {
        let ilon = lon_to_ilon(area.lon);
        let ilat = lat_to_ilat(area.lat);
        let [kx, ky] = get_lon_lat_to_meter_scales(ilat);
        let dlon_micros = if kx > 0.0 {
            (area.radius_m / kx).ceil() as i32 + 1
        } else {
            0
        };
        let dlat_micros = if ky > 0.0 {
            (area.radius_m / ky).ceil() as i32 + 1
        } else {
            0
        };
        Self {
            ilon,
            ilat,
            radius_m: area.radius_m,
            weight: area.weight,
            min_lon: ilon - dlon_micros,
            max_lon: ilon + dlon_micros,
            min_lat: ilat - dlat_micros,
            max_lat: ilat + dlat_micros,
        }
    }

    #[inline(always)]
    pub fn is_hard(&self) -> bool {
        match self.weight {
            None => true,
            Some(w) => w < 0.0 || w.is_nan(),
        }
    }
}

/// Result of evaluating a segment against active no-go zones.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NogoCheckResult {
    /// The segment is clear of hard no-go zones, with an optional cumulative penalty cost.
    Pass { added_cost: u32 },
    /// The segment touches a hard no-go exclusion zone and must be rejected.
    Blocked,
}

/// Parses no-go areas from BRouter's `nogos` query parameter format:
/// `lon,lat,radius[,weight]|lon,lat,radius[,weight]|...`
pub fn parse_nogos(s: &str) -> Vec<NogoArea> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let mut res = Vec::new();
    for item in trimmed.split('|') {
        let item = item.trim();
        if item.is_empty() {
            continue;
        }
        let parts: Vec<&str> = item.split(',').collect();
        if parts.len() < 3 {
            continue;
        }
        let Ok(lon) = parts[0].trim().parse::<f64>() else {
            continue;
        };
        let Ok(lat) = parts[1].trim().parse::<f64>() else {
            continue;
        };
        let Ok(radius_m) = parts[2].trim().parse::<f64>() else {
            continue;
        };
        if radius_m <= 0.0 {
            continue;
        }
        let weight = if parts.len() > 3 {
            let w_str = parts[3].trim();
            if w_str.is_empty()
                || w_str.eq_ignore_ascii_case("nan")
                || w_str.eq_ignore_ascii_case("undefined")
            {
                None
            } else {
                w_str.parse::<f64>().ok()
            }
        } else {
            None
        };
        res.push(NogoArea {
            lon,
            lat,
            radius_m,
            weight,
        });
    }
    res
}

/// Removes no-go zones that contain any of the given waypoints, matching BRouter's `cleanNogoList`.
///
/// This prevents routes from becoming impossible when a waypoint is placed inside an avoided circle.
pub fn clean_nogos(nogos: &[NogoArea], waypoints: &[Point2D]) -> Vec<InternalNogo> {
    let mut result = Vec::with_capacity(nogos.len());
    for area in nogos {
        let internal = InternalNogo::from_area(area);
        let mut discard = false;
        let nogo_pt = Point2D::new(internal.ilon, internal.ilat);
        for wp in waypoints {
            if distance(*wp, nogo_pt) < internal.radius_m {
                discard = true;
                break;
            }
        }
        if !discard {
            result.push(internal);
        }
    }
    result
}

/// Calculates the distance of a segment inside a circle, matching BRouter's
/// `OsmNodeNamed.distanceWithinRadius`.
pub fn distance_within_radius(
    mut lon1: i32,
    mut lat1: i32,
    mut lon2: i32,
    mut lat2: i32,
    total_segment_length: f64,
    center_lon: i32,
    center_lat: i32,
    radius: f64,
) -> f64 {
    let [kx, ky] = get_lon_lat_to_meter_scales((lat1 + lat2) >> 1);
    let first_inside =
        distance(Point2D::new(lon1, lat1), Point2D::new(center_lon, center_lat)) < radius;
    let mut last_inside =
        distance(Point2D::new(lon2, lat2), Point2D::new(center_lon, center_lat)) < radius;

    if first_inside {
        if last_inside {
            return total_segment_length;
        }
        std::mem::swap(&mut lon1, &mut lon2);
        std::mem::swap(&mut lat1, &mut lat2);
        last_inside = first_inside;
    }

    let initial_to_project = ((lon2 - lon1) as f64 * (center_lon - lon1) as f64 * kx * kx
        + (lat2 - lat1) as f64 * (center_lat - lat1) as f64 * ky * ky)
        / total_segment_length;

    let initial_to_center = distance(Point2D::new(center_lon, center_lat), Point2D::new(lon1, lat1));
    let under_sqrt = (radius * radius
        - (initial_to_center * initial_to_center - initial_to_project * initial_to_project))
        .max(0.0);
    let half_dist = under_sqrt.sqrt();

    if last_inside {
        half_dist + (total_segment_length - initial_to_project)
    } else {
        2.0 * half_dist
    }
}

/// Tests whether a segment between `p1` and `p2` intersects any no-go area,
/// using the exact BRouter distance formula from `RoutingContext.calcDistance`.
pub fn check_segment_against_nogos(
    p1: Point2D,
    p2: Point2D,
    nogos: &[InternalNogo],
) -> NogoCheckResult {
    if nogos.is_empty() {
        return NogoCheckResult::Pass { added_cost: 0 };
    }

    let seg_min_lon = p1.lon.min(p2.lon);
    let seg_max_lon = p1.lon.max(p2.lon);
    let seg_min_lat = p1.lat.min(p2.lat);
    let seg_max_lat = p1.lat.max(p2.lat);

    let [dlon2m, dlat2m] = get_lon_lat_to_meter_scales((p1.lat + p2.lat) >> 1);
    let dx = (p2.lon - p1.lon) as f64 * dlon2m;
    let dy = (p2.lat - p1.lat) as f64 * dlat2m;
    let d = (dx * dx + dy * dy).sqrt();

    let mut total_added_cost = 0u32;

    for nogo in nogos {
        // Fast AABB rejection
        if seg_max_lon < nogo.min_lon
            || seg_min_lon > nogo.max_lon
            || seg_max_lat < nogo.min_lat
            || seg_min_lat > nogo.max_lat
        {
            continue;
        }

        if d <= 0.0 {
            let dist = distance(p1, Point2D::new(nogo.ilon, nogo.ilat));
            if dist < nogo.radius_m {
                if nogo.is_hard() {
                    return NogoCheckResult::Blocked;
                } else if let Some(w) = nogo.weight {
                    total_added_cost += (dist * w).round() as u32;
                }
            }
            continue;
        }

        let x1 = (p1.lon - nogo.ilon) as f64 * dlon2m;
        let y1 = (p1.lat - nogo.ilat) as f64 * dlat2m;
        let x2 = (p2.lon - nogo.ilon) as f64 * dlon2m;
        let y2 = (p2.lat - nogo.ilat) as f64 * dlat2m;
        let r12 = x1 * x1 + y1 * y1;
        let r22 = x2 * x2 + y2 * y2;
        let mut radius = (if r12 < r22 {
            y1 * dx - x1 * dy
        } else {
            y2 * dx - x2 * dy
        })
        .abs()
            / d;

        if radius < nogo.radius_m {
            let mut s1 = x1 * dx + y1 * dy;
            let mut s2 = x2 * dx + y2 * dy;

            if s1 < 0.0 {
                s1 = -s1;
                s2 = -s2;
            }
            if s2 > 0.0 {
                radius = (if s1 < s2 { r12 } else { r22 }).sqrt();
                if radius > nogo.radius_m {
                    continue;
                }
            }

            // Segment intersects the nogo circle
            if nogo.is_hard() {
                return NogoCheckResult::Blocked;
            } else if let Some(w) = nogo.weight {
                let dist_within = distance_within_radius(
                    p1.lon,
                    p1.lat,
                    p2.lon,
                    p2.lat,
                    d,
                    nogo.ilon,
                    nogo.ilat,
                    nogo.radius_m,
                );
                total_added_cost += (dist_within * w).round() as u32;
            }
        }
    }

    NogoCheckResult::Pass {
        added_cost: total_added_cost,
    }
}

/// Tests whether a polyline intersects any no-go area.
pub fn check_polyline_against_nogos(
    poly: &[Point3D],
    nogos: &[InternalNogo],
) -> NogoCheckResult {
    if nogos.is_empty() || poly.len() < 2 {
        return NogoCheckResult::Pass { added_cost: 0 };
    }
    let mut total_added_cost = 0u32;
    for i in 0..poly.len() - 1 {
        match check_segment_against_nogos(poly[i].to_2d(), poly[i + 1].to_2d(), nogos) {
            NogoCheckResult::Blocked => return NogoCheckResult::Blocked,
            NogoCheckResult::Pass { added_cost } => total_added_cost += added_cost,
        }
    }
    NogoCheckResult::Pass {
        added_cost: total_added_cost,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_nogos() {
        let empty = parse_nogos("");
        assert!(empty.is_empty());

        let single = parse_nogos("-0.12,51.50,50");
        assert_eq!(single.len(), 1);
        assert_eq!(single[0].lon, -0.12);
        assert_eq!(single[0].lat, 51.50);
        assert_eq!(single[0].radius_m, 50.0);
        assert!(single[0].is_hard());

        let weighted = parse_nogos("-0.12,51.50,50,15.5|-0.15,51.52,100,-1");
        assert_eq!(weighted.len(), 2);
        assert_eq!(weighted[0].weight, Some(15.5));
        assert!(!weighted[0].is_hard());
        assert_eq!(weighted[1].weight, Some(-1.0));
        assert!(weighted[1].is_hard());
    }

    #[test]
    fn test_segment_nogo_intersection() {
        // Point in central London
        let nogo = NogoArea::new(-0.1278, 51.5074, 50.0);
        let internal = [InternalNogo::from_area(&nogo)];

        // Segment straight through the center
        let p1 = Point2D::new(lon_to_ilon(-0.1288), lat_to_ilat(51.5074));
        let p2 = Point2D::new(lon_to_ilon(-0.1268), lat_to_ilat(51.5074));

        let res = check_segment_against_nogos(p1, p2, &internal);
        assert_eq!(res, NogoCheckResult::Blocked);

        // Segment completely outside (500m north)
        let p3 = Point2D::new(lon_to_ilon(-0.1288), lat_to_ilat(51.5150));
        let p4 = Point2D::new(lon_to_ilon(-0.1268), lat_to_ilat(51.5150));

        let res2 = check_segment_against_nogos(p3, p4, &internal);
        assert_eq!(res2, NogoCheckResult::Pass { added_cost: 0 });
    }

    #[test]
    fn test_clean_nogos_removes_containing_waypoints() {
        let nogo1 = NogoArea::new(-0.12, 51.50, 100.0);
        let nogo2 = NogoArea::new(-0.20, 51.60, 100.0);
        let wps = [Point2D::new(lon_to_ilon(-0.1201), lat_to_ilat(51.5001))];

        let cleaned = clean_nogos(&[nogo1, nogo2], &wps);
        assert_eq!(cleaned.len(), 1);
        assert_eq!(cleaned[0].ilon, lon_to_ilon(-0.20));
    }
}
