//! Rust implementation corresponding to:
//! - Java package: `btools.router`
//! - Java source: `https://github.com/abrensch/brouter/tree/master/brouter-core/src/main/java/btools/router`
//!
//! # Summary
//! Core routing engine, kinematic physics modeling, path state tracking,
//! elevation hysteresis buffers, and 2-pass guided A* search.

pub mod cost;
pub mod path;
pub mod search;

pub use cost::*;
pub use path::*;
pub use search::*;
