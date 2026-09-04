#![allow(
    clippy::expect_used,
    clippy::float_cmp,
    clippy::indexing_slicing,
    dead_code,
    missing_docs,
    unreachable_pub,
    reason = "focused integration assertions use exact fixture values"
)]

#[path = "../src/model.rs"]
mod model;
#[path = "../src/observation.rs"]
mod observation;
#[path = "../src/search.rs"]
mod search;
#[path = "support/search.rs"]
mod support;

use search::SearchResponse;
use serde_json::{Value, json};
use support::{FakeServer, ResponsePlan, run_search};

#[tokio::test]
async fn node_code_point_limit_and_thumbnail_validation_match() {
    // Given: Node-accepted astral/combining boundaries and its URL-parser candidate matrix.
    let astral_513_utf16 = format!("{}a", "😀".repeat(256));
    let combining_512_code_points = "e\u{0301}".repeat(256);
    let rejected_astral = "😀".repeat(513);
    let response = run_custom_search(vec![
        renderer(
            "astral-513-utf16",
            &astral_513_utf16,
            &json!([{ "url": "ftp://images.example/cover" }]),
        ),
        renderer(
            "combining-512-code-points",
            &combining_512_code_points,
            &json!([{ "url": "data:text/plain,cover" }]),
        ),
        renderer(
            "astral-513-code-points",
            &rejected_astral,
            &json!([{ "url": "https://images.example/cover" }]),
        ),
        renderer(
            "relative-before-valid",
            "Title",
            &json!([{ "url": "/relative" }, { "url": "https://images.example/cover" }]),
        ),
        renderer(
            "malformed-before-valid",
            "Title",
            &json!([{ "url": "not a url" }, { "url": "https://images.example/cover" }]),
        ),
    ])
    .await;

    // When: Rust parses the same candidate shapes accepted by the retained Node schema.

    // Then: code points, non-HTTP metadata URLs, and every thumbnail candidate follow Node semantics.
    assert_eq!(response.results.len(), 2);
    assert_eq!(response.results[0].track.title, astral_513_utf16);
    assert_eq!(
        response.results[0].track.artwork_url,
        "ftp://images.example/cover"
    );
    assert_eq!(response.results[0].score, 1.0);
    assert_eq!(response.results[1].track.title, combining_512_code_points);
    assert_eq!(
        response.results[1].track.artwork_url,
        "data:text/plain,cover"
    );
    assert_eq!(response.results[1].score, 0.9);

    let null_thumbnail = run_custom_search(vec![renderer(
        "null-thumbnail",
        "Title",
        &json!([{ "url": null }]),
    )])
    .await;
    assert!(null_thumbnail.results.is_empty());
}

async fn run_custom_search(renderers: Vec<Value>) -> SearchResponse {
    let body = serde_json::to_vec(&json!({
        "contents": renderers
            .into_iter()
            .map(|video_renderer| json!({ "videoRenderer": video_renderer }))
            .collect::<Vec<_>>(),
    }))
    .expect("custom response body must serialize");
    let server = FakeServer::spawn(ResponsePlan::Body(body), 1)
        .await
        .expect("fake server must bind");
    run_search(&server)
        .await
        .expect("custom fixture search must succeed")
}

fn renderer(id: &str, title: &str, thumbnails: &Value) -> Value {
    json!({
        "videoId": id,
        "title": { "runs": [{ "text": title }] },
        "ownerText": { "runs": [{ "text": "Artist" }] },
        "lengthText": { "simpleText": "1:00" },
        "thumbnail": { "thumbnails": thumbnails },
    })
}
