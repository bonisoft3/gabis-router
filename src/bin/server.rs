//! Drop-in HTTP API server binary for rsrouter.
//! Reference implementation: `https://github.com/abrensch/brouter`
//!
//! Exposes the standard `/brouter` endpoint on port 17777 (or configurable port)
//! for direct compatibility with brouter-web and navigation apps.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use clap::Parser;
use rsrouter::server::{create_router, ServerState};

#[derive(Parser, Debug)]
#[command(name = "rsrouter-server")]
#[command(about = "Drop-in BRouter HTTP API server in Rust", long_about = None)]
struct Cli {
    /// Port to listen on
    #[arg(short, long, default_value = "17777")]
    port: u16,

    /// Host address to bind to
    #[arg(long, default_value = "0.0.0.0")]
    host: String,

    /// Path to directory containing .rd5 segment files
    #[arg(short, long, default_value = "data/segments4")]
    segments: PathBuf,

    /// Path to directory containing .brf profiles and lookups.dat
    #[arg(short, long, default_value = "profiles")]
    profiles: PathBuf,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    println!("Starting rsrouter server on {}:{}", cli.host, cli.port);
    println!("Segments directory: {:?}", cli.segments);
    println!("Profiles directory: {:?}", cli.profiles);

    let state = Arc::new(ServerState::new(cli.segments, cli.profiles)?);
    let app = create_router(state);

    let addr: SocketAddr = format!("{}:{}", cli.host, cli.port).parse()?;
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    println!("Server listening on http://{}", addr);

    axum::serve(listener, app).await?;
    Ok(())
}
