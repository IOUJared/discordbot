#![allow(
    clippy::expect_used,
    clippy::float_cmp,
    clippy::indexing_slicing,
    dead_code,
    missing_docs,
    unreachable_pub,
    reason = "integration assertions and task-scoped path imports precede route integration"
)]

#[path = "../src/model.rs"]
mod model;
#[path = "../src/observation.rs"]
mod observation;
#[path = "../src/search.rs"]
mod search;
#[path = "support/search.rs"]
mod support;

use std::{collections::BTreeSet, sync::atomic::Ordering, time::Duration};

use search::SearchResponse;
use serde_json::{Value, json};
use support::{FakeServer, Manifest, ResponsePlan, fixture_body, read_fixture, run_search};

#[tokio::test]
async fn search_manifest_parity() {
    // Given: every shared Innertube raw fixture and its declared response fixture.
    let manifest: Manifest = serde_json::from_slice(&read_fixture("manifest.json"))
        .expect("manifest must be valid JSON");
    let items = manifest
        .raw
        .iter()
        .filter(|item| item.source_kind == "innertube")
        .collect::<Vec<_>>();
    assert_eq!(items.len(), 2, "every Innertube item must be consumed");
    assert_eq!(
        items
            .iter()
            .map(|item| item.path.as_str())
            .collect::<Vec<_>>(),
        vec![
            "raw/innertube-ordinal-malformed-valid.json",
            "raw/innertube-padding.json",
        ]
    );
    for item in items {
        assert_eq!(item.expected.outcome, "response");
        let expected_path = item
            .expected
            .fixture
            .as_deref()
            .expect("response fixture path must exist");
        let expected: SearchResponse = serde_json::from_slice(&read_fixture(expected_path))
            .expect("expected response must be valid JSON");
        let server = FakeServer::spawn(ResponsePlan::Body(read_fixture(&item.path)), 1)
            .await
            .expect("fake server must bind");

        // When: Rust searches the declared raw bytes through the real HTTP adapter.
        let actual = run_search(&server)
            .await
            .expect("fixture search must succeed");

        // Then: every declared corpus-normalized response matches exactly.
        assert_eq!(actual, expected);
        assert_eq!(server.calls.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn malformed_renderer_keeps_raw_ordinal() {
    // Given: malformed ordinal zero followed by valid renderers.
    let server = FakeServer::spawn(ResponsePlan::Body(fixture_body().to_vec()), 1)
        .await
        .expect("fake server must bind");

    // When: the response is normalized.
    let response = run_search(&server)
        .await
        .expect("fixture search must succeed");

    // Then: malformed zero consumes its slot while every valid result through slot four remains.
    let expected: SearchResponse =
        serde_json::from_slice(&read_fixture("fixtures/responses/search-ordinal.json"))
            .expect("expected response must be valid JSON");
    assert_eq!(response, expected);
    assert_eq!(
        response
            .results
            .iter()
            .map(|result| (result.track.id.as_str(), result.score))
            .collect::<Vec<_>>(),
        vec![
            ("valid-ordinal-1", 0.9),
            ("valid-ordinal-2", 0.8),
            ("valid-ordinal-3", 0.7),
            ("valid-ordinal-4", 0.6),
        ]
    );
    assert!(
        response
            .results
            .iter()
            .all(|result| result.track.id != "outside-window-5")
    );
}

#[tokio::test]
async fn all_invalid_slots_return_no_results() {
    // Given: every raw renderer in the bounded window is malformed.
    let response = run_custom_search(vec![malformed_renderer(); 5]).await;

    // When: the sidecar normalizes the renderer window.

    // Then: no malformed candidate becomes a public result.
    assert!(response.results.is_empty());
}

#[tokio::test]
async fn mixed_valid_and_invalid_slots_keep_original_ordinals() {
    // Given: malformed renderer slots interleave three valid renderers.
    let response = run_custom_search(vec![
        malformed_renderer(),
        valid_renderer("valid-1"),
        malformed_renderer(),
        valid_renderer("valid-3"),
        valid_renderer("valid-4"),
    ])
    .await;

    // When: the sidecar normalizes the raw renderer window.

    // Then: valid results retain source order and the scores of their raw slots.
    assert_eq!(
        response
            .results
            .iter()
            .map(|result| (result.track.id.as_str(), result.score))
            .collect::<Vec<_>>(),
        vec![("valid-1", 0.9), ("valid-3", 0.7), ("valid-4", 0.6)]
    );
}

#[tokio::test]
async fn slot_four_is_included_and_slot_five_is_excluded() {
    // Given: six syntactically valid raw renderers.
    let response = run_custom_search(
        (0..6)
            .map(|ordinal| valid_renderer(&format!("slot-{ordinal}")))
            .collect(),
    )
    .await;

    // When: the sidecar applies its fixed five-renderer bound.

    // Then: slot four remains and slot five never enters the response.
    assert_eq!(response.results.len(), 5);
    assert_eq!(response.results[4].track.id, "slot-4");
    assert_eq!(response.results[4].score, 0.6);
    assert!(
        response
            .results
            .iter()
            .all(|result| result.track.id != "slot-5")
    );
}

#[tokio::test]
async fn padded_text_matches_node_track_normalization() {
    // Given: ECMAScript-trimmable edge whitespace, empty-after-trim, and overlong UTF-16 slots.
    let overlong_title = "😀".repeat(256) + "a";
    let response = run_custom_search(vec![
        renderer_with_text(
            "padded-0",
            "\u{feff} Padded Title \u{a0}",
            "\u{a0} Padded Artist \u{feff}",
            "1:02",
        ),
        renderer_with_text("blank-after-trim-1", "\u{feff}\u{a0}", "Artist", "2:00"),
        renderer_with_text(
            "padded-2",
            "\u{200a} Second Title \u{2029}",
            "\u{202f} Second Artist \u{205f}",
            "2:03",
        ),
        renderer_with_text("overlong-utf16-3", &overlong_title, "Artist", "3:00"),
    ])
    .await;

    // When: the same raw renderer shape crosses the Rust boundary.

    // Then: text matches Node's trimmed TrackSchema output and the blank slot still consumes ordinal one.
    assert_eq!(
        response
            .results
            .iter()
            .map(|result| {
                (
                    result.track.id.as_str(),
                    result.track.title.as_str(),
                    result.track.artist.as_str(),
                    result.track.url.as_str(),
                    result.track.duration_ms,
                    result.score,
                )
            })
            .collect::<Vec<_>>(),
        vec![
            (
                "padded-0",
                "Padded Title",
                "Padded Artist",
                "https://www.youtube.com/watch?v=padded-0",
                62_000,
                1.0,
            ),
            (
                "padded-2",
                "Second Title",
                "Second Artist",
                "https://www.youtube.com/watch?v=padded-2",
                123_000,
                0.8,
            ),
        ]
    );
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

fn malformed_renderer() -> Value {
    json!({ "videoId": 7, "title": { "runs": [{ "text": "Malformed" }] } })
}

fn valid_renderer(id: &str) -> Value {
    renderer_with_text(id, id, "Artist", "1:00")
}

fn renderer_with_text(id: &str, title: &str, artist: &str, duration: &str) -> Value {
    json!({
        "videoId": id,
        "title": { "runs": [{ "text": title }] },
        "ownerText": { "runs": [{ "text": artist }] },
        "lengthText": { "simpleText": duration },
        "thumbnail": { "thumbnails": [{ "url": format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg") }] },
    })
}

#[test]
fn observation_schema_is_allowlisted() {
    // Given: one provider observation containing only bounded metadata.
    let event = observation::ObservationEvent::new(
        uuid::Uuid::nil(),
        observation::Stage::InnertubeUpstream,
        observation::Outcome::Success,
        Duration::from_millis(12),
        observation::CounterDelta::INCREMENT,
    );

    // When: the event crosses the structured logging boundary.
    let value = serde_json::to_value(event).expect("observation must serialize");

    // Then: only the private allowlisted schema is present.
    let keys = value
        .as_object()
        .expect("observation must be an object")
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    assert_eq!(
        keys,
        BTreeSet::from([
            "correlationId",
            "counterDelta",
            "durationMs",
            "outcome",
            "schema",
            "stage",
        ])
    );
    let encoded = value.to_string();
    assert!(!encoded.contains("query"));
    assert!(!encoded.contains("youtube.com"));
    assert!(!encoded.contains("valid-ordinal"));
}
