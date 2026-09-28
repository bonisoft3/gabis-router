//! Integration tests for the HTTP API server.
//! Reference implementation: `https://github.com/abrensch/brouter`

use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use rsrouter::server::{create_router, ServerState};
use tower::ServiceExt;

#[tokio::test]
async fn test_health_endpoint() {
    let state = Arc::new(
        ServerState::new(
            PathBuf::from("data/segments4"),
            PathBuf::from("profiles"),
        )
        .expect("Failed to initialize ServerState"),
    );

    let app = create_router(state);

    let response = app
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = response.into_body().collect().await.unwrap().to_bytes();
    let body_str = String::from_utf8_lossy(&body);
    assert!(body_str.contains("\"status\":\"ok\""));
    assert!(body_str.contains("\"engine\":\"rsrouter\""));
}

#[tokio::test]
async fn test_brouter_endpoint_missing_params() {
    let state = Arc::new(
        ServerState::new(
            PathBuf::from("data/segments4"),
            PathBuf::from("profiles"),
        )
        .expect("Failed to initialize ServerState"),
    );

    let app = create_router(state);

    // 1. Missing lonlats
    let res1 = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/brouter")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res1.status(), StatusCode::BAD_REQUEST);

    // 2. Invalid profile
    let res2 = app
        .oneshot(
            Request::builder()
                .uri("/brouter?lonlats=-0.14,51.46|-0.05,51.54&profile=non_existent_profile")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res2.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn test_brouter_endpoint_successful_route() {
    if !std::path::Path::new("data/segments4/W5_N50.rd5").exists() {
        println!("Skipping route test: W5_N50.rd5 not found");
        return;
    }

    let state = Arc::new(
        ServerState::new(
            PathBuf::from("data/segments4"),
            PathBuf::from("profiles"),
        )
        .expect("Failed to initialize ServerState"),
    );

    let app = create_router(state);

    let uri = "/brouter?lonlats=-0.143613,51.462414|-0.055296,51.544998&profile=fastbike&format=geojson";
    let response = app
        .oneshot(
            Request::builder()
                .uri(uri)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let body = response.into_body().collect().await.unwrap().to_bytes();
    let geojson = String::from_utf8_lossy(&body);

    assert!(geojson.contains("\"FeatureCollection\""));
    assert!(geojson.contains("\"LineString\""));
    assert!(geojson.contains("\"track-length\""));
    assert!(geojson.contains("\"cost\""));
    println!("API test successful: returned {} bytes of GeoJSON", geojson.len());
}
