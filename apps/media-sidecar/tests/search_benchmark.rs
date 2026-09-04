#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::print_stdout,
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

use std::{
    sync::atomic::Ordering,
    time::{Duration, Instant},
};

use tokio_util::sync::CancellationToken;

use search::{SearchClient, SearchResponse};
use support::{FakeServer, ResponsePlan, fixture_body, read_fixture};

#[tokio::test]
async fn search_benchmark_30_warmups_200_samples_p95_under_1000ms() {
    // Given: a deterministic local upstream and one reused direct client.
    const WARMUPS: usize = 30;
    const SAMPLES: usize = 200;
    let server = FakeServer::spawn(
        ResponsePlan::Body(fixture_body().to_vec()),
        WARMUPS + SAMPLES,
    )
    .await
    .expect("fake server must bind");
    let client = SearchClient::for_test(server.endpoint.clone()).expect("test client must build");
    let token = CancellationToken::new();
    let expected: SearchResponse =
        serde_json::from_slice(&read_fixture("fixtures/responses/search-ordinal.json"))
            .expect("expected response must be valid JSON");
    for _ in 0..WARMUPS {
        client
            .search("warmup", &token)
            .await
            .expect("warmup must succeed");
    }
    let mut samples = Vec::with_capacity(SAMPLES);
    let mut parity_matches = 0_usize;

    // When: two hundred uncached HTTP calls are timed monotonically.
    for sample in 0..SAMPLES {
        let started = Instant::now();
        let result = client
            .search(&format!("sample-{sample}"), &token)
            .await
            .expect("sample must succeed");
        if result == expected {
            parity_matches = parity_matches.saturating_add(1);
        }
        samples.push(started.elapsed());
    }
    samples.sort_unstable();
    let p95 = samples[(SAMPLES * 95 / 100) - 1];

    // Then: exact calls, zero errors, full parity, and sub-second p95 are observed.
    assert_eq!(server.calls.load(Ordering::SeqCst), WARMUPS + SAMPLES);
    assert_eq!(parity_matches, SAMPLES);
    assert!(p95 < Duration::from_secs(1), "p95 was {p95:?}");
    let parity_percent = parity_matches
        .saturating_mul(100)
        .checked_div(SAMPLES)
        .unwrap_or(0);
    println!(
        "{{\"warmups\":{WARMUPS},\"samples\":{SAMPLES},\"errors\":0,\"parityPercent\":{parity_percent},\"p95Micros\":{}}}",
        p95.as_micros()
    );
}
