//! Drop-in HTTP API server binary for rsrouter.
//! Reference implementation: `https://github.com/abrensch/brouter`
//!
//! Exposes the standard `/brouter` endpoint on port 17777 (or configurable port)
//! for direct compatibility with brouter-web and navigation apps.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use clap::Parser;
use rsrouter_server::{create_router, ServerState};

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
    #[arg(long, default_value = "profiles")]
    profiles: PathBuf,

    /// Optional bounding box to preload at startup in min_lon,min_lat,max_lon,max_lat format
    #[arg(long)]
    preload_bbox: Option<String>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();

    println!("Starting rsrouter server on {}:{}", cli.host, cli.port);
    println!("Segments directory: {:?}", cli.segments);
    println!("Profiles directory: {:?}", cli.profiles);

    let state = if let Some(bbox_str) = cli.preload_bbox {
        let parts: Vec<f64> = bbox_str
            .split(',')
            .filter_map(|s| s.trim().parse::<f64>().ok())
            .collect();
        if parts.len() != 4 {
            eprintln!("Invalid --preload-bbox format, expected min_lon,min_lat,max_lon,max_lat");
            std::process::exit(1);
        }
        println!(
            "Preloading regional graph for bbox: lon [{:.2}, {:.2}], lat [{:.2}, {:.2}]...",
            parts[0], parts[2], parts[1], parts[3]
        );
        let t0 = std::time::Instant::now();
        let state = ServerState::with_preloaded_bbox(
            cli.segments,
            cli.profiles,
            parts[0],
            parts[1],
            parts[2],
            parts[3],
        )?;
        println!("Graph preloaded in {:.2} ms", t0.elapsed().as_secs_f64() * 1000.0);
        Arc::new(state)
    } else {
        Arc::new(ServerState::new(cli.segments, cli.profiles)?)
    };
    let app = create_router(state);

    let addr: SocketAddr = format!("{}:{}", cli.host, cli.port).parse()?;
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    println!("Server listening on http://{}", addr);

    axum::serve(listener, app).await?;
    Ok(())
}
