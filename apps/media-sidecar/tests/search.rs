#![allow(
    clippy::expect_used,
    clippy::float_cmp,
    clippy::indexing_slicing,
    clippy::print_stdout,
    dead_code,
    missing_docs,
    unreachable_pub,
    reason = "integration assertions and task-scoped path imports precede route integration"
)]

// allow: SIZE_OK — one integration harness owns the fake wire and every required search scenario.

#[path = "../src/model.rs"]
mod model;
#[path = "../src/observation.rs"]
mod observation;
#[path = "../src/search.rs"]
mod search;

use std::{
    collections::BTreeSet,
    io,
    path::PathBuf,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use serde::Deserialize;
use tokio::{
    io::{AsyncReadExt as _, AsyncWriteExt as _},
    net::{TcpListener, TcpStream},
    process::Command,
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
use url::Url;

use search::{SearchClient, SearchError, SearchResponse};

const RAW_FIXTURE: &str = "innertube-ordinal-malformed-valid.json";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    raw: Vec<ManifestItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestItem {
    path: String,
    source_kind: String,
    expected: ManifestExpected,
}

#[derive(Debug, Deserialize)]
struct ManifestExpected {
    outcome: String,
    fixture: Option<String>,
}

enum ResponsePlan {
    Body(Vec<u8>),
    Redirect(String),
    Stall,
}

struct FakeServer {
    endpoint: Url,
    calls: Arc<AtomicUsize>,
    task: JoinHandle<io::Result<()>>,
}

impl FakeServer {
    async fn spawn(plan: ResponsePlan, maximum_calls: usize) -> io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let calls = Arc::new(AtomicUsize::new(0));
        let observed_calls = Arc::clone(&calls);
        let task = tokio::spawn(async move {
            for _ in 0..maximum_calls {
                let (stream, _) = listener.accept().await?;
                observed_calls.fetch_add(1, Ordering::SeqCst);
                respond(stream, &plan).await;
            }
            Ok(())
        });
        let endpoint = Url::parse(&format!("http://{address}/youtubei/v1/search"))
            .map_err(io::Error::other)?;
        Ok(Self {
            endpoint,
            calls,
            task,
        })
    }
}

impl Drop for FakeServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn respond(mut stream: TcpStream, plan: &ResponsePlan) {
    let mut request = [0_u8; 4096];
    if stream.read(&mut request).await.is_err() {
        return;
    }
    match plan {
        ResponsePlan::Body(body) => {
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            if stream.write_all(header.as_bytes()).await.is_ok() {
                let _result = stream.write_all(body).await;
            }
        }
        ResponsePlan::Redirect(location) => {
            let response = format!(
                "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            let _result = stream.write_all(response.as_bytes()).await;
        }
        ResponsePlan::Stall => tokio::time::sleep(Duration::from_secs(4)).await,
    }
}

fn spec_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../spec/media-sidecar/v1")
        .join(relative)
}

fn read_fixture(relative: &str) -> Vec<u8> {
    std::fs::read(spec_path(relative)).expect("fixture must be readable")
}

const fn fixture_body() -> &'static [u8] {
    include_bytes!("../../../spec/media-sidecar/v1/raw/innertube-ordinal-malformed-valid.json")
}

async fn search(server: &FakeServer) -> Result<SearchResponse, SearchError> {
    let client = SearchClient::for_test(server.endpoint.clone())?;
    client
        .search("Northern Lines", &CancellationToken::new())
        .await
}

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
    let actual = search(&server).await.expect("fixture search must succeed");

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
    let response = search(&server).await.expect("fixture search must succeed");

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

#[tokio::test]
async fn search_deadline() {
    // Given: an upstream that accepts the request but never sends headers in time.
    let server = FakeServer::spawn(ResponsePlan::Stall, 1)
        .await
        .expect("fake server must bind");
    let started = Instant::now();

    // When: the bounded search is performed.
    let result = search(&server).await;

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
    let result = search(&server).await;

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
    let redirect_result = search(&redirect).await;

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

    // When: the child searches with poisoned upper/lowercase proxy variables.
    let response = client
        .search("direct", &CancellationToken::new())
        .await
        .expect("no-proxy client must connect directly");

    // Then: the direct response is valid.
    assert_eq!(response.results[0].track.id, "valid-ordinal-1");
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
