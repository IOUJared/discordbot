#![allow(
    clippy::expect_used,
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

use std::{
    process::Stdio,
    sync::atomic::Ordering,
    time::{Duration, Instant},
};

use tokio::process::Command;
use tokio_util::sync::CancellationToken;
use url::Url;

use search::{SearchClient, SearchError};
use support::{FakeServer, ResponsePlan, fixture_body, run_search};

#[tokio::test]
async fn search_deadline() {
    // Given: an upstream that accepts the request but never sends headers in time.
    let server = FakeServer::spawn(ResponsePlan::Stall, 1)
        .await
        .expect("fake server must bind");
    let started = Instant::now();

    // When: the bounded search is performed.
    let result = run_search(&server).await;

    // Then: the typed deadline arrives within the provider bound plus scheduler slack.
    assert_eq!(
        result.expect_err("slow search must fail"),
        SearchError::DeadlineExceeded
    );
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[tokio::test]
async fn search_response_cap() {
    // Given: an upstream response one byte above the one-MiB cap.
    let oversized = vec![b' '; search::MAXIMUM_RESPONSE_BYTES + 1];
    let server = FakeServer::spawn(ResponsePlan::Body(oversized), 1)
        .await
        .expect("fake server must bind");

    // When: the streamed response crosses the cap.
    let result = run_search(&server).await;

    // Then: no partial result is returned.
    assert_eq!(
        result.expect_err("oversized response must fail"),
        SearchError::ExtractorFailed
    );
}

#[tokio::test]
async fn proxy_and_redirect_are_disabled() {
    // Given: a counting proxy, direct upstream, and redirect target.
    let proxy = FakeServer::spawn(ResponsePlan::Body(b"proxy".to_vec()), 1)
        .await
        .expect("proxy sentinel must bind");
    let direct = FakeServer::spawn(ResponsePlan::Body(fixture_body().to_vec()), 1)
        .await
        .expect("direct fake must bind");
    let target = FakeServer::spawn(ResponsePlan::Body(fixture_body().to_vec()), 1)
        .await
        .expect("redirect target must bind");
    let redirect = FakeServer::spawn(ResponsePlan::Redirect(target.endpoint.to_string()), 1)
        .await
        .expect("redirect fake must bind");
    let output = Command::new(std::env::current_exe().expect("test binary path must exist"))
        .arg("proxy_child_probe")
        .arg("--exact")
        .arg("--nocapture")
        .env("SEARCH_DIRECT_ENDPOINT", direct.endpoint.as_str())
        .env("HTTP_PROXY", proxy.endpoint.as_str())
        .env("HTTPS_PROXY", proxy.endpoint.as_str())
        .env("http_proxy", proxy.endpoint.as_str())
        .env("https_proxy", proxy.endpoint.as_str())
        .env("SEARCH_PROXY_CHILD", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .expect("proxy child must run");

    // When: a redirecting upstream is searched without the poisoned environment.
    let redirect_result = run_search(&redirect).await;

    // Then: the direct child succeeds, proxy/redirect target receive no requests.
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(direct.calls.load(Ordering::SeqCst), 1);
    assert_eq!(proxy.calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        redirect_result.expect_err("redirect must fail"),
        SearchError::ExtractorFailed
    );
    assert_eq!(redirect.calls.load(Ordering::SeqCst), 1);
    assert_eq!(target.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn proxy_child_probe() {
    // Given: this helper is inert except in the explicitly isolated child process.
    if std::env::var_os("SEARCH_PROXY_CHILD").is_none() {
        return;
    }
    let endpoint = Url::parse(
        &std::env::var("SEARCH_DIRECT_ENDPOINT").expect("child endpoint must be provided"),
    )
    .expect("child endpoint must be a URL");
    let client = SearchClient::for_test(endpoint).expect("test client must build");
    assert!(rustls::crypto::CryptoProvider::get_default().is_some());

    // When: the child searches with poisoned upper/lowercase proxy variables.
    let response = client
        .search("direct", &CancellationToken::new())
        .await
        .expect("no-proxy client must connect directly");

    // Then: the direct response is valid.
    assert_eq!(response.results[0].track.id, "valid-ordinal-1");
}

#[tokio::test]
#[ignore = "live HTTPS acceptance is run explicitly before deployment"]
async fn live_https_search_uses_the_pinned_provider() {
    let client = SearchClient::new().expect("production HTTPS client must build");
    let response = client
        .search(
            "never gonna give you up official video",
            &CancellationToken::new(),
        )
        .await
        .expect("direct HTTPS search must succeed");

    assert!(!response.results.is_empty());
    assert!(rustls::crypto::CryptoProvider::get_default().is_some());
}

#[tokio::test]
async fn search_cancellation_drops_upstream_body() {
    // Given: a stalled upstream and a request cancellation token.
    let server = FakeServer::spawn(ResponsePlan::Stall, 1)
        .await
        .expect("fake server must bind");
    let client = SearchClient::for_test(server.endpoint.clone()).expect("test client must build");
    let cancellation = CancellationToken::new();
    cancellation.cancel();

    // When: search begins after cancellation.
    let result = client.search("cancelled", &cancellation).await;

    // Then: cancellation remains distinct from deadline/extractor failures.
    assert_eq!(
        result.expect_err("cancelled search must fail"),
        SearchError::Cancelled
    );
}
