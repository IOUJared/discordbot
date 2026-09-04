#![cfg(feature = "test-upstream")]
#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    missing_docs,
    reason = "black-box contract assertions terminate the test on fixture failure"
)]

#[path = "support/http_contract.rs"]
mod support;

use std::time::Duration;

use axum::{
    body::Body,
    http::{Request, StatusCode, header},
};
use discord_music_media_sidecar::test_support::TestService;
use serde_json::json;
use tower::ServiceExt as _;

use support::{FakeUpstream, fixture_executable, request, response_json, service};

async fn assert_failure_responses(responses: [axum::response::Response; 5]) {
    let [unsupported, oversized, invalid_uuid, busy, health] = responses;
    assert_eq!(
        response_json(unsupported).await,
        (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            br#"{"version":1,"error":{"code":"unsupported_media_type"}}"#.to_vec(),
            json!({"version": 1, "error": {"code": "unsupported_media_type"}})
        )
    );
    assert_eq!(
        response_json(oversized).await,
        (
            StatusCode::PAYLOAD_TOO_LARGE,
            br#"{"version":1,"error":{"code":"payload_too_large"}}"#.to_vec(),
            json!({"version": 1, "error": {"code": "payload_too_large"}})
        )
    );
    assert_eq!(response_json(invalid_uuid).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(response_json(busy).await.0, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(response_json(health).await.0, StatusCode::OK);
}

async fn assert_observations_are_redacted(service: &TestService) {
    assert!(service.observations().await.iter().all(|event| {
        let serialized = serde_json::to_value(event).expect("observation JSON");
        let object = serialized.as_object().expect("observation object");
        object.keys().map(String::as_str).collect::<Vec<_>>()
            == [
                "correlationId",
                "counterDelta",
                "durationMs",
                "outcome",
                "schema",
                "stage",
            ]
            && !serialized.to_string().contains("Northern Lines")
            && !serialized.to_string().contains("valid-ordinal-1")
    }));
}

async fn assert_resolve_error_mapping(upstream: &FakeUpstream) {
    let service = service(upstream);
    let cases = [
        (
            "mismatch",
            "https://www.youtube.com/watch?v=other",
            StatusCode::BAD_REQUEST,
            "invalid_request",
        ),
        (
            "extractor-failure",
            "https://www.youtube.com/watch?v=extractor-failure",
            StatusCode::BAD_GATEWAY,
            "extractor_failed",
        ),
    ];
    for (id, url, status, code) in cases {
        let response = service
            .router()
            .oneshot(request(
                "/v1/resolve",
                serde_json::to_vec(&json!({"version": 1, "track": {"id": id, "url": url}}))
                    .expect("resolve request JSON"),
                "application/json",
            ))
            .await
            .expect("resolve error response");
        assert_eq!(
            response_json(response).await,
            (
                status,
                format!(r#"{{"version":1,"error":{{"code":"{code}"}}}}"#).into_bytes(),
                json!({"version": 1, "error": {"code": code}})
            )
        );
    }
    service.shutdown().await.expect("error service shutdown");

    let deadline_service = TestService::new(
        upstream.endpoint.clone(),
        fixture_executable(),
        Duration::from_millis(25),
    )
    .expect("deadline service");
    let id = "tree-route-deadline";
    let response = deadline_service
        .router()
        .oneshot(request(
            "/v1/resolve",
            serde_json::to_vec(&json!({
                "version": 1,
                "track": {"id": id, "url": format!("https://www.youtube.com/watch?v={id}")}
            }))
            .expect("deadline request JSON"),
            "application/json",
        ))
        .await
        .expect("deadline response");
    assert_eq!(
        response_json(response).await,
        (
            StatusCode::GATEWAY_TIMEOUT,
            br#"{"version":1,"error":{"code":"deadline_exceeded"}}"#.to_vec(),
            json!({"version": 1, "error": {"code": "deadline_exceeded"}})
        )
    );
    deadline_service
        .shutdown()
        .await
        .expect("deadline service shutdown");
    for suffix in ["pids", "argv", "env"] {
        let _ignored =
            tokio::fs::remove_file(format!("/tmp/discord-music-sidecar-{id}.{suffix}")).await;
    }
}

#[tokio::test]
async fn http_failure_and_disconnect_matrix() {
    // Given: four stalled operations consume every permit.
    let mut upstream = FakeUpstream::spawn(true).await;
    let service = service(&upstream);
    let search_body = br#"{"version":1,"query":"Northern Lines"}"#.to_vec();
    let mut pending = Vec::new();
    for _ in 0..4 {
        let future = service.router().oneshot(request(
            "/v1/search",
            search_body.clone(),
            "application/json",
        ));
        pending.push(tokio::spawn(future));
    }
    upstream.wait_calls(4).await;

    // When: invalid framing, saturation, health, and a dropped handler are exercised.
    let unsupported = service
        .router()
        .oneshot(request("/v1/search", b"version=1".to_vec(), "text/plain"))
        .await
        .expect("unsupported response");
    let oversized = service
        .router()
        .oneshot(request(
            "/v1/search",
            vec![b'x'; 16 * 1024 + 1],
            "application/json",
        ))
        .await
        .expect("oversized response");
    let invalid_uuid = Request::builder()
        .method("POST")
        .uri("/v1/search")
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-media-sidecar-correlation-id", "query-is-not-a-uuid")
        .body(Body::from(search_body.clone()))
        .expect("invalid UUID request");
    let invalid_uuid = service
        .router()
        .oneshot(invalid_uuid)
        .await
        .expect("invalid UUID response");
    let busy = service
        .router()
        .oneshot(request("/v1/search", search_body, "application/json"))
        .await
        .expect("busy response");
    let health = service
        .router()
        .oneshot(
            Request::builder()
                .uri("/healthz")
                .body(Body::empty())
                .expect("health request"),
        )
        .await
        .expect("health response");
    pending.pop().expect("pending request").abort();
    service.wait_for_active(3).await.expect("drop cancellation");

    // Then: failures are exact, health bypasses saturation, and cancellation cleans first.
    assert_failure_responses([unsupported, oversized, invalid_uuid, busy, health]).await;
    upstream.release.cancel();
    for pending_request in pending {
        let response = pending_request
            .await
            .expect("request task")
            .expect("request response");
        assert_eq!(response.status(), StatusCode::OK);
    }
    service.wait_for_idle().await.expect("registry idle");
    assert_observations_are_redacted(&service).await;
    service.shutdown().await.expect("service shutdown");
    assert_resolve_error_mapping(&upstream).await;
}
