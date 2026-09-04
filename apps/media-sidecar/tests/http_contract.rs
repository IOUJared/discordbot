#![cfg(feature = "test-upstream")]
#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::print_stdout,
    missing_docs,
    reason = "black-box contract assertions terminate the test on fixture failure"
)]

use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use discord_music_media_sidecar::test_support::TestService;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncReadExt as _, AsyncWriteExt as _},
    net::{TcpListener, TcpStream},
    process::Command,
    sync::watch,
};
use tokio_util::sync::CancellationToken;
use tower::ServiceExt as _;
use url::Url;
use uuid::Uuid;

const SEARCH_BODY: &[u8] =
    include_bytes!("../../../spec/media-sidecar/v1/raw/innertube-ordinal-malformed-valid.json");

#[derive(Debug)]
struct FakeUpstream {
    endpoint: Url,
    calls: Arc<AtomicUsize>,
    changed: watch::Receiver<usize>,
    release: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

impl FakeUpstream {
    async fn spawn(stalled: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("fake upstream bind");
        let address = listener.local_addr().expect("fake upstream address");
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&calls);
        let (changed_tx, changed) = watch::channel(0_usize);
        let release = CancellationToken::new();
        let task_release = release.clone();
        let task = tokio::spawn(async move {
            loop {
                let accepted = listener.accept().await;
                let Ok((socket, _)) = accepted else { return };
                let count = observed
                    .fetch_add(1, Ordering::SeqCst)
                    .checked_add(1)
                    .expect("call count range");
                let _ignored = changed_tx.send(count);
                let connection_release = task_release.clone();
                tokio::spawn(async move {
                    respond(socket, stalled, connection_release).await;
                });
            }
        });
        Self {
            endpoint: Url::parse(&format!("http://{address}/youtubei/v1/search"))
                .expect("fake upstream URL"),
            calls,
            changed,
            release,
            task,
        }
    }

    async fn wait_calls(&mut self, expected: usize) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while *self.changed.borrow_and_update() < expected {
                self.changed.changed().await.expect("call counter open");
            }
        })
        .await
        .expect("upstream call deadline");
    }
}

impl Drop for FakeUpstream {
    fn drop(&mut self) {
        self.release.cancel();
        self.task.abort();
    }
}

async fn respond(mut socket: TcpStream, stalled: bool, release: CancellationToken) {
    let mut request = [0_u8; 4096];
    if socket.read(&mut request).await.is_err() {
        return;
    }
    if stalled {
        release.cancelled().await;
    }
    let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        SEARCH_BODY.len()
    );
    if socket.write_all(headers.as_bytes()).await.is_ok() {
        let _ignored = socket.write_all(SEARCH_BODY).await;
    }
}

fn fixture_executable() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-yt-dlp")
}

fn request(path: &str, body: Vec<u8>, content_type: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(path)
        .header(header::CONTENT_TYPE, content_type)
        .header("x-media-sidecar-correlation-id", Uuid::new_v4().to_string())
        .body(Body::from(body))
        .expect("request")
}

async fn response_json(response: axum::response::Response) -> (StatusCode, Vec<u8>, Value) {
    let status = response.status();
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE),
        Some(&header::HeaderValue::from_static("application/json"))
    );
    let bytes = to_bytes(response.into_body(), 1_048_576)
        .await
        .expect("response body")
        .to_vec();
    let value = serde_json::from_slice(&bytes).expect("response JSON");
    (status, bytes, value)
}

fn service(upstream: &FakeUpstream) -> TestService {
    TestService::new(
        upstream.endpoint.clone(),
        fixture_executable(),
        Duration::from_secs(30),
    )
    .expect("test service")
}

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
        .oneshot(request(
            "/v1/search",
            search_body.clone(),
            "application/json",
        ))
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

#[tokio::test]
async fn shutdown_cancels_reaps_and_joins_registry() {
    // Given: the feature-only release harness owns four live yt-dlp process groups.
    let upstream = FakeUpstream::spawn(false).await;
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("port reserve");
    let port = listener.local_addr().expect("reserved address").port();
    drop(listener);
    let mut child = Command::new(env!("CARGO_BIN_EXE_media-sidecar-test-harness"))
        .env("SIDECAR_HOST", "127.0.0.1")
        .env("SIDECAR_PORT", port.to_string())
        .env("SIDECAR_TEST_UPSTREAM", upstream.endpoint.as_str())
        .env("SIDECAR_TEST_YT_DLP", fixture_executable())
        .kill_on_drop(true)
        .spawn()
        .expect("test harness spawn");
    wait_for_health(port).await;
    let client = reqwest::Client::new();
    let mut requests = Vec::new();
    let mut records = Vec::new();
    for ordinal in 0..4 {
        let id = format!("tree-shutdown-{ordinal}");
        let url = format!("http://127.0.0.1:{port}/v1/resolve");
        let request_client = client.clone();
        let request_id = id.clone();
        requests.push(tokio::spawn(async move {
            request_client
                .post(url)
                .header("x-media-sidecar-correlation-id", Uuid::new_v4().to_string())
                .json(&json!({
                    "version": 1,
                    "track": {
                        "id": request_id,
                        "url": format!("https://www.youtube.com/watch?v={request_id}")
                    }
                }))
                .send()
                .await
        }));
        records.push(PathBuf::from(format!(
            "/tmp/discord-music-sidecar-{id}.pids"
        )));
    }
    let process_ids = wait_for_records(&records).await;

    // When: SIGTERM closes admission and initiates the ten-second supervised drain.
    let pid = child.id().expect("harness pid");
    let started = Instant::now();
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(i32::try_from(pid).expect("pid range")),
        nix::sys::signal::Signal::SIGTERM,
    )
    .expect("send SIGTERM");
    let status = tokio::time::timeout(Duration::from_secs(10), child.wait())
        .await
        .expect("shutdown deadline")
        .expect("harness wait");

    // Then: all direct children/groups are gone and the joined harness exits cleanly.
    assert!(status.success());
    assert!(started.elapsed() < Duration::from_secs(10));
    for pid in process_ids.split_whitespace() {
        assert!(!PathBuf::from(format!("/proc/{pid}")).exists());
    }
    for request_task in requests {
        let response = request_task
            .await
            .expect("shutdown request task")
            .expect("shutdown response");
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            response.bytes().await.expect("shutdown response body"),
            br#"{"version":1,"error":{"code":"internal"}}"#[..]
        );
    }
    for path in records {
        for suffix in ["pids", "argv", "env"] {
            let cleanup = path.with_extension(suffix);
            let _ignored = tokio::fs::remove_file(cleanup).await;
        }
    }
}

async fn wait_for_health(port: u16) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)).await {
                let _ignored = stream
                    .write_all(
                        b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
                    )
                    .await;
                let mut response = Vec::new();
                if stream.read_to_end(&mut response).await.is_ok()
                    && response.windows(6).any(|window| window == b"200 OK")
                {
                    return;
                }
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("health deadline");
}

async fn wait_for_records(paths: &[PathBuf]) -> String {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let mut all = String::new();
            let mut complete = true;
            for path in paths {
                match tokio::fs::read_to_string(path).await {
                    Ok(value) => {
                        all.push_str(&value);
                        all.push(' ');
                    }
                    Err(_) => complete = false,
                }
            }
            if complete {
                return all;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("process record deadline")
}
