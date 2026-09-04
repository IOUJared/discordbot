#![cfg(feature = "test-upstream")]
#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    missing_docs,
    reason = "black-box contract assertions terminate the test on fixture failure"
)]

#[path = "support/http_contract.rs"]
mod support;

use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

use axum::http::StatusCode;
use serde_json::json;
use tokio::{
    io::{AsyncReadExt as _, AsyncWriteExt as _},
    net::{TcpListener, TcpStream},
    process::Command,
};
use uuid::Uuid;

use support::{FakeUpstream, fixture_executable};

#[tokio::test]
async fn shutdown_cancels_reaps_and_joins_registry() {
    // Given: the feature-only release harness owns four live yt-dlp process groups.
    let _provider = rustls::crypto::ring::default_provider().install_default();
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
