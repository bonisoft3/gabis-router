//! # route-tools
//!
//! Custom product utilities built on top of `brouter-rs`:
//! - GPX / GPS track map-matching and minimal editable waypoint extraction (`map_match`).
//! - Surface, highway, noise, traffic, and maxspeed segment breakdown extraction (`segments`).

pub mod map_match;
pub mod segments;

pub use map_match::*;
pub use segments::*;
