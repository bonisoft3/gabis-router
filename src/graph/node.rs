//! Rust implementation corresponding to:
//! - Java class: `btools.mapaccess.OsmNode`
//! - Java source: `https://github.com/abrensch/brouter/blob/master/brouter-mapaccess/src/main/java/btools/mapaccess/OsmNode.java`
//!
//! # Summary
//! Node container in the routing graph holding coordinates, elevation,
//! OSM node tags, and turn restrictions.

use crate::rd5::micro_cache::DecodedTurnRestriction;

/// Unique 64-bit integer identifier derived from integer `(ilon, ilat)`.
#[inline]
pub fn make_node_id(ilon: i32, ilat: i32) -> u64 {
    ((ilon as u64) << 32) | (ilat as u32 as u64)
}

/// Unpack integer `(ilon, ilat)` from a 64-bit node ID.
#[inline]
pub fn unpack_node_id(id: u64) -> (i32, i32) {
    let ilon = (id >> 32) as i32;
    let ilat = id as u32 as i32;
    (ilon, ilat)
}

/// An OSM node in the routing graph.
#[derive(Debug, Clone, PartialEq)]
pub struct OsmNode {
    pub ilon: i32,
    pub ilat: i32,
    pub selev: i16,
    pub node_description: Option<Vec<u8>>,
    pub turn_restrictions: Vec<DecodedTurnRestriction>,
}

impl OsmNode {
    pub fn new(ilon: i32, ilat: i32) -> Self {
        Self {
            ilon,
            ilat,
            selev: i16::MIN,
            node_description: None,
            turn_restrictions: Vec::new(),
        }
    }

    pub fn with_elevation(ilon: i32, ilat: i32, selev: i16) -> Self {
        Self {
            ilon,
            ilat,
            selev,
            node_description: None,
            turn_restrictions: Vec::new(),
        }
    }

    #[inline]
    pub fn id(&self) -> u64 {
        make_node_id(self.ilon, self.ilat)
    }

    #[inline]
    pub fn elevation_meters(&self) -> f64 {
        self.selev as f64 / 4.0
    }
}
