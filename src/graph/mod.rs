//! Rust implementation corresponding to:
//! - Java package: `btools.mapaccess`
//! - Java source: `https://github.com/abrensch/brouter/tree/master/brouter-mapaccess/src/main/java/btools/mapaccess`
//! - Java package: `btools.util`
//! - Java source: `https://github.com/abrensch/brouter/tree/master/brouter-util/src/main/java/btools/util`
//!
//! # Summary
//! Graph topology, spatial geodesics, intermediate link geometry decoding,
//! and spatial waypoint matching.

pub mod spatial;
pub mod node;
pub mod link;
pub mod matcher;
pub mod routing_graph;

pub use spatial::*;
pub use node::*;
pub use link::*;
pub use matcher::*;
pub use routing_graph::*;
