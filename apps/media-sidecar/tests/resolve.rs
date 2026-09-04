#![cfg(unix)]
#![allow(
    dead_code,
    missing_docs,
    unreachable_pub,
    reason = "production modules are compiled through this isolated integration harness before route wiring"
)]
#![allow(
    clippy::expect_used,
    reason = "test fixture setup failures must terminate their owning scenario"
)]

#[path = "../src/process.rs"]
mod process;
#[path = "../src/resolve.rs"]
mod resolve;

use std::{path::PathBuf, time::Duration};

use resolve::{ResolveError, ResolveRequest, Resolver, TrackRequest};
use tokio::{
    io::{AsyncReadExt as _, AsyncWriteExt as _},
    net::TcpListener,
};
use tokio_util::sync::CancellationToken;

const EXPECTED_ENV: &str = "HOME=/nonexistent\nLANG=C.UTF-8\nLC_ALL=C.UTF-8\nPATH=/usr/local/bin:/usr/bin:/bin\nSSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt\nTMPDIR=/tmp\n";

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

fn record(id: &str, suffix: &str) -> PathBuf {
    PathBuf::from(format!("/tmp/discord-music-sidecar-{id}.{suffix}"))
}

async fn cleanup_record(id: &str) {
    for suffix in ["argv", "env", "pids"] {
        let _ignored = tokio::fs::remove_file(record(id, suffix)).await;
    }
}

async fn wait_for_file(path: &std::path::Path) -> String {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Ok(value) = tokio::fs::read_to_string(path).await {
                return value;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("fixture record deadline")
}

async fn wait_for_gone(pids: &str) {
    let parsed = pids
        .split_whitespace()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if parsed
                .iter()
                .all(|pid| !PathBuf::from(format!("/proc/{pid}")).exists())
            {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("process tree cleanup deadline");
}

#[tokio::test]
async fn resolve_manifest_parity() {
    // Given: each yt-dlp raw corpus class is emitted by the real fixture process.
    let resolver = Resolver::for_test(fixture(), Duration::from_secs(2), None);
    let manifest: serde_json::Value = serde_json::from_slice(
        &tokio::fs::read(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../spec/media-sidecar/v1/manifest.json"),
        )
        .await
        .expect("manifest bytes"),
    )
    .expect("manifest json");
    let ids = [
        ("ytdlp-resolve-valid.json", "valid-ordinal-1"),
        ("ytdlp-resolve-host-header.json", "manifest-host"),
        ("ytdlp-resolve-manifest-protocol.json", "manifest-protocol"),
        ("ytdlp-resolve-malformed.json", "manifest-malformed"),
        ("ytdlp-resolve-invalid-json.txt", "manifest-invalid-json"),
    ];
    // When: every case crosses the bounded process and parser boundary.
    let raw = manifest
        .get("raw")
        .and_then(serde_json::Value::as_array)
        .expect("raw items");
    let mut consumed = 0_usize;
    for item in raw
        .iter()
        .filter(|item| item.get("sourceKind").and_then(serde_json::Value::as_str) == Some("yt-dlp"))
    {
        let path = item
            .get("path")
            .and_then(serde_json::Value::as_str)
            .expect("raw path");
        let (id, valid) = ids
            .iter()
            .find(|(name, _)| path.ends_with(name))
            .map(|(name, id)| (*id, *name == "ytdlp-resolve-valid.json"))
            .expect("mapped raw item");
        let result = resolver
            .resolve(&request(id), CancellationToken::new())
            .await;
        // Then: only the canonical valid item becomes the exact remote media response.
        if valid {
            let response = result.expect("valid corpus response");
            assert_eq!(response.media.bitrate_kbps, Some(252));
            assert_eq!(
                response.media.headers.get("User-Agent").map(String::as_str),
                Some("fixture-agent")
            );
        } else {
            assert!(matches!(result, Err(ResolveError::InvalidOutput)));
        }
        cleanup_record(id).await;
        consumed += 1;
    }
    assert_eq!(consumed, ids.len());
}

#[tokio::test]
async fn resolve_fixed_argv() {
    // Given: a valid canonical request and a cookie path.
    let resolver = Resolver::for_test(
        fixture(),
        Duration::from_secs(2),
        Some("/run/secrets/youtube.cookies.txt".into()),
    );
    // When: resolution succeeds.
    resolver
        .resolve(&request("argv-fixed"), CancellationToken::new())
        .await
        .expect("resolve");
    // Then: the executable sees the exact fixed prefix, cookie pair, and bestaudio suffix.
    let argv = tokio::fs::read_to_string(record("argv-fixed", "argv"))
        .await
        .expect("argv");
    let expected = "--ignore-config\n--proxy\n\n--js-runtimes\ndeno:/usr/local/bin/deno\n--cookies\n/run/secrets/youtube.cookies.txt\n--no-playlist\n--no-warnings\n-f\nbestaudio\n--print\n%(.{url,http_headers,ext,acodec,abr,protocol})#j\nhttps://www.youtube.com/watch?v=argv-fixed\n";
    assert_eq!(argv, expected);
    cleanup_record("argv-fixed").await;
}

#[tokio::test]
async fn proxy_sentinel_receives_zero_connections() {
    // Given: poisoned parent proxies, a counting sentinel, and a direct target.
    let sentinel = TcpListener::bind("127.0.0.1:0").await.expect("sentinel");
    let direct = TcpListener::bind("127.0.0.1:0").await.expect("direct");
    let sentinel_port = sentinel.local_addr().expect("sentinel address").port();
    let direct_port = direct.local_addr().expect("direct address").port();
    let direct_task = tokio::spawn(async move {
        let (mut socket, _) = direct.accept().await.expect("direct request");
        let mut bytes = [0_u8; 512];
        let _ = socket.read(&mut bytes).await.expect("read direct");
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
            .await
            .expect("reply direct");
    });
    // When: the fixture performs its direct fetch and resolve.
    let id = format!("proxy-direct-{direct_port}-{sentinel_port}");
    Resolver::for_test(fixture(), Duration::from_secs(2), None)
        .resolve(&request(&id), CancellationToken::new())
        .await
        .expect("direct resolve");
    direct_task.await.expect("direct task");
    // Then: no proxy connection occurred and the child environment is exact.
    assert!(
        tokio::time::timeout(Duration::from_millis(100), sentinel.accept())
            .await
            .is_err()
    );
    assert_eq!(
        tokio::fs::read_to_string(record(&id, "env"))
            .await
            .expect("env"),
        EXPECTED_ENV
    );
    cleanup_record(&id).await;
}

async fn assert_tree_cleanup(
    id: &str,
    action: impl FnOnce(CancellationToken) + Send + 'static,
) -> ResolveError {
    let _ignored = tokio::fs::remove_file(record(id, "pids")).await;
    let token = CancellationToken::new();
    let task_token = token.clone();
    let owned_id = id.to_owned();
    let resolver = Resolver::for_test(fixture(), Duration::from_millis(150), None);
    let handle =
        tokio::spawn(async move { resolver.resolve(&request(&owned_id), task_token).await });
    let pids = wait_for_file(&record(id, "pids")).await;
    action(token);
    let result = handle.await.expect("resolver task");
    wait_for_gone(&pids).await;
    cleanup_record(id).await;
    result.expect_err("interrupted process must not resolve")
}

#[tokio::test]
async fn resolve_timeout_kills_process_group() {
    // Given/When: a process tree exceeds the configured deadline.
    assert!(matches!(
        assert_tree_cleanup("tree-timeout", |_| {}).await,
        ResolveError::Deadline
    ));
    // Then: the shared helper observes both fixture PIDs gone before returning.
}

#[tokio::test]
async fn resolve_cancel_kills_process_group() {
    // Given/When: caller cancellation interrupts a live process tree.
    assert!(matches!(
        assert_tree_cleanup("tree-cancel", |token| token.cancel()).await,
        ResolveError::Cancelled
    ));
    // Then: the shared helper observes both fixture PIDs gone before returning.
}

#[tokio::test]
async fn dropped_resolver_kills_process_group() {
    // Given: a resolver future owns a live fixture tree.
    let id = "tree-drop";
    let _ignored = tokio::fs::remove_file(record(id, "pids")).await;
    let resolver = Resolver::for_test(fixture(), Duration::from_secs(30), None);
    let handle = tokio::spawn(async move {
        resolver
            .resolve(&request(id), CancellationToken::new())
            .await
    });
    let pids = wait_for_file(&record(id, "pids")).await;
    // When: the caller drops the in-flight future.
    handle.abort();
    assert!(handle.await.is_err());
    // Then: its drop signal kills and reaps the whole process group.
    wait_for_gone(&pids).await;
    cleanup_record(id).await;
}

#[tokio::test]
async fn mismatch_and_output_cap_fail_safely() {
    // Given: a mismatched canonical ID/URL and an oversized fixture output.
    let resolver = Resolver::for_test(fixture(), Duration::from_secs(2), None);
    cleanup_record("not-the-url").await;
    let mut mismatch = request("not-the-url");
    mismatch.track.url = "https://www.youtube.com/watch?v=other".into();
    // When/Then: mismatch fails before spawn; oversized output is rejected.
    assert!(matches!(
        resolver.resolve(&mismatch, CancellationToken::new()).await,
        Err(ResolveError::InvalidRequest)
    ));
    assert!(!record("not-the-url", "argv").exists());
    assert!(matches!(
        resolver
            .resolve(&request("oversized"), CancellationToken::new())
            .await,
        Err(ResolveError::OutputLimit)
    ));
    cleanup_record("oversized").await;
    assert!(matches!(
        resolver
            .resolve(&request("stderr-oversized"), CancellationToken::new())
            .await,
        Err(ResolveError::OutputLimit)
    ));
    cleanup_record("stderr-oversized").await;
}
