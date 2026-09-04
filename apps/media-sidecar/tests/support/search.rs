#![allow(
    dead_code,
    reason = "shared integration support is compiled separately for each focused test target"
)]

use std::{
    io,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use serde::Deserialize;
use tokio::{
    io::{AsyncReadExt as _, AsyncWriteExt as _},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::search::{SearchClient, SearchError, SearchResponse};

pub const RAW_FIXTURE: &str = "innertube-ordinal-malformed-valid.json";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub raw: Vec<ManifestItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestItem {
    pub path: String,
    pub source_kind: String,
    pub expected: ManifestExpected,
}

#[derive(Debug, Deserialize)]
pub struct ManifestExpected {
    pub outcome: String,
    pub fixture: Option<String>,
}

pub enum ResponsePlan {
    Body(Vec<u8>),
    Redirect(String),
    Stall,
}

pub struct FakeServer {
    pub endpoint: Url,
    pub calls: Arc<AtomicUsize>,
    task: JoinHandle<io::Result<()>>,
}

impl FakeServer {
    pub async fn spawn(plan: ResponsePlan, maximum_calls: usize) -> io::Result<Self> {
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

pub fn spec_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../spec/media-sidecar/v1")
        .join(relative)
}

pub fn read_fixture(relative: &str) -> Vec<u8> {
    std::fs::read(spec_path(relative)).expect("fixture must be readable")
}

pub const fn fixture_body() -> &'static [u8] {
    include_bytes!("../../../../spec/media-sidecar/v1/raw/innertube-ordinal-malformed-valid.json")
}

pub async fn run_search(server: &FakeServer) -> Result<SearchResponse, SearchError> {
    let client = SearchClient::for_test(server.endpoint.clone())?;
    client
        .search("Northern Lines", &CancellationToken::new())
        .await
}
