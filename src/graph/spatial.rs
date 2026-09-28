//! Rust implementation corresponding to:
//! - Java class: `btools.util.CheapRuler`
//! - Java source: `https://github.com/abrensch/brouter/blob/master/brouter-util/src/main/java/btools/util/CheapRuler.java`
//! - Java class: `btools.util.CheapAngleMeter`
//! - Java source: `https://github.com/abrensch/brouter/blob/master/brouter-util/src/main/java/btools/util/CheapAngleMeter.java`
//!
//! # Summary
//! High-speed geodesic distance, scale factor, and angle calculations using
//! precomputed trigonometric lookup tables matching BRouter's 1800-entry cache.

use std::sync::LazyLock;

pub const ILATLNG_TO_LATLNG: f64 = 1e-6;
pub const KILOMETERS_TO_METERS: f64 = 1000.0;
pub const DEG_TO_RAD: f64 = std::f64::consts::PI / 180.0;
pub const RAD_TO_DEG: f64 = 180.0 / std::f64::consts::PI;

pub const SCALE_CACHE_LENGTH: usize = 1800;
pub const SCALE_CACHE_INCREMENT: i32 = 100000;

/// Global precomputed scale cache for (kx, ky) multipliers.
static SCALE_CACHE: LazyLock<[[f64; 2]; SCALE_CACHE_LENGTH]> = LazyLock::new(|| {
    let mut cache = [[0.0; 2]; SCALE_CACHE_LENGTH];
    for i in 0..SCALE_CACHE_LENGTH {
        let ilat = (i as i32) * SCALE_CACHE_INCREMENT + SCALE_CACHE_INCREMENT / 2;
        cache[i] = calc_kx_ky_from_ilat(ilat);
    }
    cache
});

fn calc_kx_ky_from_ilat(ilat: i32) -> [f64; 2] {
    let lat = DEG_TO_RAD * (ilat as f64 * ILATLNG_TO_LATLNG - 90.0);
    let cos = lat.cos();
    let cos2 = 2.0 * cos * cos - 1.0;
    let cos3 = 2.0 * cos * cos2 - cos;
    let cos4 = 2.0 * cos * cos3 - cos2;
    let cos5 = 2.0 * cos * cos4 - cos3;

    let kx = (111.41513 * cos - 0.09455 * cos3 + 0.00012 * cos5)
        * ILATLNG_TO_LATLNG
        * KILOMETERS_TO_METERS;
    let ky = (111.13209 - 0.56605 * cos2 + 0.0012 * cos4)
        * ILATLNG_TO_LATLNG
        * KILOMETERS_TO_METERS;
    [kx, ky]
}

/// Convert longitude in decimal degrees to BRouter integer longitude (`ilon`).
#[inline]
pub fn lon_to_ilon(lon: f64) -> i32 {
    ((lon + 180.0) * 1_000_000.0).round() as i32
}

/// Convert latitude in decimal degrees to BRouter integer latitude (`ilat`).
#[inline]
pub fn lat_to_ilat(lat: f64) -> i32 {
    ((lat + 90.0) * 1_000_000.0).round() as i32
}

/// Convert BRouter integer longitude (`ilon`) to decimal degrees.
#[inline]
pub fn ilon_to_lon(ilon: i32) -> f64 {
    (ilon - 180_000_000) as f64 * ILATLNG_TO_LATLNG
}

/// Convert BRouter integer latitude (`ilat`) to decimal degrees.
#[inline]
pub fn ilat_to_lat(ilat: i32) -> f64 {
    (ilat - 90_000_000) as f64 * ILATLNG_TO_LATLNG
}

/// Convert 1/4 meter units `selev` to meters.
#[inline]
pub fn selev_to_elevation(selev: i16) -> f64 {
    if selev == i16::MIN {
        0.0
    } else {
        selev as f64 / 4.0
    }
}

/// Convert meters to 1/4 meter units `selev`.
#[inline]
pub fn elevation_to_selev(elev_m: f64) -> i16 {
    (elev_m * 4.0).round() as i16
}

/// Returns `[kx, ky]` distance multipliers (meters per microdegree) for given `ilat`.
#[inline]
pub fn get_lon_lat_to_meter_scales(ilat: i32) -> [f64; 2] {
    let idx = (ilat / SCALE_CACHE_INCREMENT) as usize;
    if idx < SCALE_CACHE_LENGTH {
        SCALE_CACHE[idx]
    } else {
        SCALE_CACHE[SCALE_CACHE_LENGTH - 1]
    }
}

/// Geodesic distance in meters between two points `(ilon1, ilat1)` and `(ilon2, ilat2)`.
#[inline]
pub fn distance(ilon1: i32, ilat1: i32, ilon2: i32, ilat2: i32) -> f64 {
    let kxky = get_lon_lat_to_meter_scales((ilat1 + ilat2) >> 1);
    let dlon = (ilon1 - ilon2) as f64 * kxky[0];
    let dlat = (ilat1 - ilat2) as f64 * kxky[1];
    (dlat * dlat + dlon * dlon).sqrt()
}

/// Calculate turn angle and its cosine for three consecutive points.
///
/// Returns `(angle_degrees, cos_angle)`.
pub fn calc_angle(
    lon0: i32,
    lat0: i32,
    lon1: i32,
    lat1: i32,
    lon2: i32,
    lat2: i32,
) -> (f64, f64) {
    let kxky = get_lon_lat_to_meter_scales(lat1);
    let lon2m = kxky[0];
    let lat2m = kxky[1];

    let dx10 = (lon1 - lon0) as f64 * lon2m;
    let dy10 = (lat1 - lat0) as f64 * lat2m;
    let dx21 = (lon2 - lon1) as f64 * lon2m;
    let dy21 = (lat2 - lat1) as f64 * lat2m;

    let dd = ((dx10 * dx10 + dy10 * dy10) * (dx21 * dx21 + dy21 * dy21)).sqrt();
    if dd == 0.0 {
        return (0.0, 1.0);
    }

    let mut sinp = (dy10 * dx21 - dx10 * dy21) / dd;
    let cosp = (dy10 * dy21 + dx10 * dx21) / dd;
    let cosangle = cosp;

    let mut offset = 0.0;
    let mut s2 = sinp * sinp;
    if s2 > 0.5 {
        if sinp > 0.0 {
            offset = 90.0;
            sinp = -cosp;
        } else {
            offset = -90.0;
            sinp = cosp;
        }
        s2 = cosp * cosp;
    } else if cosp < 0.0 {
        sinp = -sinp;
        offset = if sinp > 0.0 { -180.0 } else { 180.0 };
    }

    let angle = offset + sinp * (57.4539 + s2 * (9.57565 + s2 * (4.30904 + s2 * 2.56491)));
    (angle, cosangle)
}

/// Bearing in degrees (0..360) from point 1 to point 2.
pub fn get_direction(lon1: i32, lat1: i32, lon2: i32, lat2: i32) -> f64 {
    let xdiff = (lat2 - lat1) as f64;
    let ydiff = (lon2 - lon1) as f64;
    let res = ydiff.atan2(xdiff) * RAD_TO_DEG;
    normalize(res)
}

/// Normalizes an angle into `[0.0, 360.0)`.
#[inline]
pub fn normalize(a: f64) -> f64 {
    if a >= 360.0 {
        a - (360.0 * (a / 360.0).floor())
    } else if a < 0.0 {
        a - (360.0 * ((a / 360.0).floor()))
    } else {
        a
    }
}

/// Absolute difference in degrees between two bearings `[0, 180]`.
#[inline]
pub fn get_difference_from_direction(b1: f64, b2: f64) -> f64 {
    let mut r = (b2 - b1) % 360.0;
    if r < -180.0 {
        r += 360.0;
    }
    if r >= 180.0 {
        r -= 360.0;
    }
    r.abs()
}
