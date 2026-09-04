#![allow(
    dead_code,
    unreachable_pub,
    reason = "shared integration support is compiled separately for each focused test target"
)]

use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use discord_music_media_sidecar::test_support::TestService;
use serde_json::Value;
use tokio::{
    io::{AsyncReadExt as _, AsyncWriteExt as _},
    net::{TcpListener, TcpStream},
    sync::watch,
};
use tokio_util::sync::CancellationToken;
use url::Url;
use uuid::Uuid;

const SEARCH_BODY: &[u8] =
    include_bytes!("../../../../spec/media-sidecar/v1/raw/innertube-ordinal-malformed-valid.json");

#[derive(Debug)]
pub struct FakeUpstream {
    pub endpoint: Url,
    pub calls: Arc<AtomicUsize>,
    changed: watch::Receiver<usize>,
    pub release: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

impl FakeUpstream {
    pub async fn spawn(stalled: bool) -> Self {
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

    pub async fn wait_calls(&mut self, expected: usize) {
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

pub fn fixture_executable() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-yt-dlp")
}

pub fn request(path: &str, body: Vec<u8>, content_type: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(path)
        .header(header::CONTENT_TYPE, content_type)
        .header("x-media-sidecar-correlation-id", Uuid::new_v4().to_string())
        .body(Body::from(body))
        .expect("request")
}

pub async fn response_json(response: axum::response::Response) -> (StatusCode, Vec<u8>, Value) {
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

pub fn service(upstream: &FakeUpstream) -> TestService {
    TestService::new(
        upstream.endpoint.clone(),
        fixture_executable(),
        Duration::from_secs(30),
    )
    .expect("test service")
}
