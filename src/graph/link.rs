//! Rust implementation corresponding to:
//! - Java class: `btools.mapaccess.OsmLink`
//! - Java source: `https://github.com/abrensch/brouter/blob/master/brouter-mapaccess/src/main/java/btools/mapaccess/OsmLink.java`
//! - Java class: `btools.mapaccess.GeometryDecoder`
//! - Java source: `https://github.com/abrensch/brouter/blob/master/brouter-mapaccess/src/main/java/btools/mapaccess/GeometryDecoder.java`
//!
//! # Summary
//! Directed edge in the routing graph with description bitmaps (way tags)
//! and variable-length delta-encoded intermediate geometry coordinates.

use crate::rd5::byte_reader::ByteDataReader;
use super::spatial;

/// Directed link between two OSM nodes in the routing graph.
#[derive(Debug, Clone, PartialEq)]
pub struct OsmLink {
    pub source_id: u64,
    pub target_id: u64,
    pub description: Option<Vec<u8>>,
    pub geometry: Option<Vec<u8>>,
    pub is_reverse: bool,
}

impl OsmLink {
    pub fn new(
        source_id: u64,
        target_id: u64,
        description: Option<Vec<u8>>,
        geometry: Option<Vec<u8>>,
        is_reverse: bool,
    ) -> Self {
        Self {
            source_id,
            target_id,
            description,
            geometry,
            is_reverse,
        }
    }

    /// Decodes the intermediate geometry coordinates between `(s_lon, s_lat, s_elev)`
    /// and `(t_lon, t_lat, t_elev)` in forward traversal order (source to target).
    pub fn decode_intermediate_points(
        &self,
        s_lon: i32,
        s_lat: i32,
        s_elev: i16,
        t_lon: i32,
        t_lat: i32,
        t_elev: i16,
    ) -> Vec<(i32, i32, i16)> {
        let Some(ref geom_bytes) = self.geometry else {
            return Vec::new();
        };

        let mut reader = ByteDataReader::new(geom_bytes);
        let mut points = Vec::new();

        if !self.is_reverse {
            let mut olon = s_lon;
            let mut olat = s_lat;
            let mut oelev = s_elev;

            while reader.has_more_data() {
                olon += reader.read_var_length_signed();
                olat += reader.read_var_length_signed();
                oelev = oelev.wrapping_add(reader.read_var_length_signed() as i16);
                points.push((olon, olat, oelev));
            }
        } else {
            // In reverse links, deltas were encoded relative to target node.
            // Reverse chaining produces points in source -> target order.
            let mut olon = t_lon;
            let mut olat = t_lat;
            let mut oelev = t_elev;

            let mut rev_points = Vec::new();
            while reader.has_more_data() {
                olon += reader.read_var_length_signed();
                olat += reader.read_var_length_signed();
                oelev = oelev.wrapping_add(reader.read_var_length_signed() as i16);
                rev_points.push((olon, olat, oelev));
            }
            rev_points.reverse();
            points = rev_points;
        }

        points
    }

    /// Returns the full polyline of coordinates including source, intermediates, and target.
    pub fn full_polyline(
        &self,
        s_lon: i32,
        s_lat: i32,
        s_elev: i16,
        t_lon: i32,
        t_lat: i32,
        t_elev: i16,
    ) -> Vec<(i32, i32, i16)> {
        let mut polyline = Vec::new();
        polyline.push((s_lon, s_lat, s_elev));
        let intermediates = self.decode_intermediate_points(
            s_lon, s_lat, s_elev,
            t_lon, t_lat, t_elev,
        );
        polyline.extend(intermediates);
        polyline.push((t_lon, t_lat, t_elev));
        polyline
    }

    /// Calculates the total geodesic distance of this link in meters along its polyline.
    pub fn calculate_distance(
        &self,
        s_lon: i32,
        s_lat: i32,
        s_elev: i16,
        t_lon: i32,
        t_lat: i32,
        t_elev: i16,
    ) -> f64 {
        let polyline = self.full_polyline(s_lon, s_lat, s_elev, t_lon, t_lat, t_elev);
        let mut total = 0.0;
        for i in 0..polyline.len() - 1 {
            let p1 = &polyline[i];
            let p2 = &polyline[i + 1];
            total += spatial::distance(p1.0, p1.1, p2.0, p2.1);
        }
        total
    }
}
