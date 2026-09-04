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
use support::{
    FakeServer, Manifest, RAW_FIXTURE, ResponsePlan, fixture_body, read_fixture, run_search,
};

#[tokio::test]
async fn search_manifest_parity() {
    // Given: the shared manifest and its only Innertube raw fixture.
    let manifest: Manifest = serde_json::from_slice(&read_fixture("manifest.json"))
        .expect("manifest must be valid JSON");
    let items = manifest
        .raw
        .iter()
        .filter(|item| item.source_kind == "innertube")
        .collect::<Vec<_>>();
    assert_eq!(items.len(), 1, "every Innertube item must be consumed");
    let item = items[0];
    assert_eq!(item.path, format!("raw/{RAW_FIXTURE}"));
    assert_eq!(item.expected.outcome, "response");
    let expected_path = item
        .expected
        .fixture
        .as_deref()
        .expect("response fixture path must exist");
    let expected: SearchResponse = serde_json::from_slice(&read_fixture(expected_path))
        .expect("expected response must be valid JSON");
    let server = FakeServer::spawn(ResponsePlan::Body(fixture_body().to_vec()), 1)
        .await
        .expect("fake server must bind");

    // When: Rust searches the raw bytes through the real HTTP adapter.
    let actual = run_search(&server)
        .await
        .expect("fixture search must succeed");

    // Then: the corpus-normalized result matches and no sixth ordinal leaks.
    assert_eq!(actual, expected);
    assert!(
        actual
            .results
            .iter()
            .all(|result| result.track.id != "outside-window-5")
    );
    assert_eq!(server.calls.load(Ordering::SeqCst), 1);
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

    // Then: malformed zero consumes its slot and ordinal five is excluded.
    assert_eq!(response.results[0].track.id, "valid-ordinal-1");
    assert_eq!(response.results[0].score, 0.9);
    assert_eq!(response.results.len(), 1);
    assert!(
        response
            .results
            .iter()
            .all(|result| result.track.id != "outside-window-5")
    );
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
