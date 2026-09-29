//! # rsrouter
//!
//! High-performance bicycle routing engine in Rust with 1:1 parity against BRouter.
//! Direct RD5 binary file ingestion and full DSL profile support.

pub mod dsl;
pub mod graph;
pub mod rd5;
pub mod routing;
pub mod server;
pub mod types;

pub use types::*;
