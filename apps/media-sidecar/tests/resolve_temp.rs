#![cfg(unix)]
#![allow(dead_code, reason = "isolated process-cleanup integration module")]
#![allow(missing_docs, reason = "isolated process-cleanup integration module")]
#![allow(clippy::redundant_pub_crate, reason = "path harness")]
#![allow(clippy::expect_used, reason = "fixture failure terminates its test")]

#[path = "../src/process.rs"]
pub(crate) mod process;
#[path = "../src/resolve.rs"]
pub(crate) mod resolve;

use std::{path::PathBuf, time::Duration};

use resolve::{ResolveError, ResolveRequest, Resolver, TrackRequest};
use tokio_util::sync::CancellationToken;

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-yt-dlp")
}

fn request(id: &str) -> ResolveRequest {
    ResolveRequest {
        version: 1,
        track: TrackRequest {
            id: id.to_owned(),
            url: format!("https://www.youtube.com/watch?v={id}"),
        },
    }
}

fn record(id: &str) -> PathBuf {
    PathBuf::from(format!("/tmp/discord-music-sidecar-{id}.tmpdir"))
}

async fn recorded_directory(id: &str) -> PathBuf {
    let path = record(id);
    let value = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Ok(value) = tokio::fs::read_to_string(&path).await {
                return value;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("temporary directory record deadline");
    PathBuf::from(value.trim())
}

async fn assert_owned_directory_removed(id: &str) {
    let directory = recorded_directory(id).await;
    assert!(directory.starts_with("/tmp/discord-music-media-sidecar"));
    tokio::time::timeout(Duration::from_secs(2), async {
        while directory.exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("owned temporary directory cleanup deadline");
    let _ignored = tokio::fs::remove_file(record(id)).await;
}

async fn run_interrupted(id: &'static str, action: impl FnOnce(CancellationToken)) {
    let _ignored = tokio::fs::remove_file(record(id)).await;
    let token = CancellationToken::new();
    let task_token = token.clone();
    let resolver = Resolver::for_test(fixture(), Duration::from_millis(150), None);
    let handle = tokio::spawn(async move { resolver.resolve(&request(id), task_token).await });
    let _directory = recorded_directory(id).await;
    action(token);
    let _result = handle.await.expect("resolver task");
    assert_owned_directory_removed(id).await;
}

#[tokio::test]
async fn owned_temp_is_removed_after_success_and_process_error() {
    let resolver = Resolver::for_test(fixture(), Duration::from_secs(2), None);
    let _ignored = tokio::fs::remove_file(record("argv-fixed")).await;
    resolver
        .resolve(&request("argv-fixed"), CancellationToken::new())
        .await
        .expect("successful resolve");
    assert_owned_directory_removed("argv-fixed").await;
    let _ignored = tokio::fs::remove_file(record("process-error")).await;
    assert!(matches!(
        resolver
            .resolve(&request("process-error"), CancellationToken::new())
            .await,
        Err(ResolveError::ExtractorFailed)
    ));
    assert_owned_directory_removed("process-error").await;
}

#[tokio::test]
async fn owned_temp_is_removed_after_deadline_and_caller_cancellation() {
    run_interrupted("tree-timeout", |_| {}).await;
    run_interrupted("tree-cancel", |token| token.cancel()).await;
}

#[tokio::test]
async fn owned_temp_is_removed_after_future_drop() {
    let id = "tree-drop-temp";
    let _ignored = tokio::fs::remove_file(record(id)).await;
    let resolver = Resolver::for_test(fixture(), Duration::from_secs(30), None);
    let handle = tokio::spawn(async move {
        resolver
            .resolve(&request(id), CancellationToken::new())
            .await
    });
    let _directory = recorded_directory(id).await;
    handle.abort();
    assert!(handle.await.is_err());
    assert_owned_directory_removed(id).await;
}
