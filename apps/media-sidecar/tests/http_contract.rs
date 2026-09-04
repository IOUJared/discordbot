#![cfg(feature = "test-upstream")]
#![allow(
    clippy::expect_used,
    clippy::print_stdout,
    missing_docs,
    reason = "black-box contract assertions terminate the test on fixture failure"
)]

#[path = "support/http_contract.rs"]
mod support;

use std::{path::PathBuf, sync::atomic::Ordering};

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use tower::ServiceExt as _;

use support::{FakeUpstream, request, response_json, service};

#[tokio::test]
async fn http_contract() {
    // Given: the real router, deterministic upstream, and strict v1 request corpus.
    let upstream = FakeUpstream::spawn(false).await;
    let service = service(&upstream);
    let router = service.router();
    let search_request = std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../spec/media-sidecar/v1/fixtures/requests/search.json"),
    )
    .expect("search fixture");

    // When: health and search cross the assembled router.
    let health = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/healthz")
                .body(Body::empty())
                .expect("health request"),
        )
        .await
        .expect("health response");
    let search = router
        .clone()
        .oneshot(request("/v1/search", search_request, "application/json"))
        .await
        .expect("search response");
    let resolve_request = std::fs::read(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../spec/media-sidecar/v1/fixtures/requests/resolve.json"),
    )
    .expect("resolve fixture");
    let resolve = router
        .oneshot(request("/v1/resolve", resolve_request, "application/json"))
        .await
        .expect("resolve response");

    // Then: exact protocol bytes and the shared response corpus match.
    assert_eq!(
        response_json(health).await,
        (
            StatusCode::OK,
            br#"{"version":1,"status":"ok"}"#.to_vec(),
            json!({"version": 1, "status": "ok"})
        )
    );
    let (status, _, actual) = response_json(search).await;
    let expected: Value = serde_json::from_slice(
        &std::fs::read(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../spec/media-sidecar/v1/fixtures/responses/search-ordinal.json"),
        )
        .expect("response fixture"),
    )
    .expect("response fixture JSON");
    assert_eq!(status, StatusCode::OK);
    assert_eq!(actual, expected);
    let (resolve_status, _, actual_resolve) = response_json(resolve).await;
    let expected_resolve: Value = serde_json::from_slice(
        &std::fs::read(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../spec/media-sidecar/v1/fixtures/responses/resolve.json"),
        )
        .expect("resolve response fixture"),
    )
    .expect("resolve response JSON");
    assert_eq!(resolve_status, StatusCode::OK);
    assert_eq!(actual_resolve, expected_resolve);
    assert_eq!(upstream.calls.load(Ordering::SeqCst), 1);
    for suffix in ["argv", "env"] {
        let _ignored = tokio::fs::remove_file(format!(
            "/tmp/discord-music-sidecar-valid-ordinal-1.{suffix}"
        ))
        .await;
    }
    service.shutdown().await.expect("service shutdown");
}
