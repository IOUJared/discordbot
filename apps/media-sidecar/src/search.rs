use std::time::Duration;

use futures_util::StreamExt as _;
use reqwest::{StatusCode, redirect::Policy};
use rustls::crypto::CryptoProvider;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use url::Url;

use self::parsing::parse_response;

#[path = "search_parsing.rs"]
mod parsing;

const PRODUCTION_ENDPOINT: &str = "https://www.youtube.com/youtubei/v1/search";
const CLIENT_VERSION: &str = "2.20240101.00.00";
const VIDEO_FILTER: &str = "EgIQAQ%3D%3D";
const FIELD_MASK: &str = "contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents.itemSectionRenderer.contents.videoRenderer.videoId,contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents.itemSectionRenderer.contents.videoRenderer.title,contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents.itemSectionRenderer.contents.videoRenderer.ownerText,contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents.itemSectionRenderer.contents.videoRenderer.lengthText,contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents.itemSectionRenderer.contents.videoRenderer.thumbnail";
const CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
const SEARCH_DEADLINE: Duration = Duration::from_millis(2_500);
const MAXIMUM_RESPONSE_BYTES_U64: u64 = 1024 * 1024;

/// Maximum accepted bytes in a streamed Innertube response.
pub const MAXIMUM_RESPONSE_BYTES: usize = 1024 * 1024;

/// Sanitized failures from the bounded Innertube provider boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[non_exhaustive]
pub enum SearchError {
    /// The fixed HTTP client could not be constructed.
    #[error("client_build")]
    ClientBuild,
    /// Innertube returned invalid status, bytes, or typed data.
    #[error("extractor_failed")]
    ExtractorFailed,
    /// The fixed search deadline elapsed.
    #[error("deadline_exceeded")]
    DeadlineExceeded,
    /// The owning request cancelled the provider operation.
    #[error("cancelled")]
    Cancelled,
}

/// One normalized `YouTube` track from the private v1 protocol.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[non_exhaustive]
pub struct Track {
    /// `YouTube` video identifier.
    pub id: String,
    /// Fixed provider discriminator.
    pub provider: String,
    /// Video title.
    pub title: String,
    /// Video owner display text.
    pub artist: String,
    /// Canonical URL containing the identical identifier.
    pub url: String,
    /// Non-negative duration in milliseconds.
    pub duration_ms: u64,
    /// Selected upstream artwork URL.
    pub artwork_url: String,
}

/// One ordinal-scored private v1 search result.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[non_exhaustive]
pub struct SearchResult {
    /// Normalized `YouTube` track.
    pub track: Track,
    /// Score derived from the raw renderer ordinal.
    pub score: f64,
    /// Search metadata never supplies an audio bitrate.
    pub bitrate_kbps: Option<u32>,
}

/// Strict private v1 search response.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
#[non_exhaustive]
pub struct SearchResponse {
    /// Private protocol version.
    pub version: u8,
    /// At most five results from raw ordinals zero through four.
    pub results: Vec<SearchResult>,
}

/// Reusable direct-only client for the fixed Innertube search boundary.
#[derive(Clone, Debug)]
pub struct SearchClient {
    http: reqwest::Client,
    endpoint: Url,
}

impl SearchClient {
    /// Builds the production client with a compile-time fixed HTTPS authority.
    pub fn new() -> Result<Self, SearchError> {
        let endpoint = Url::parse(PRODUCTION_ENDPOINT).map_err(|_| SearchError::ClientBuild)?;
        Self::build(endpoint, true)
    }

    #[cfg(feature = "test-upstream")]
    /// Builds a deterministic test client with an injected local upstream.
    pub fn for_test(endpoint: Url) -> Result<Self, SearchError> {
        Self::build(endpoint, false)
    }

    fn build(endpoint: Url, https_only: bool) -> Result<Self, SearchError> {
        if CryptoProvider::get_default().is_none()
            && rustls::crypto::ring::default_provider()
                .install_default()
                .is_err()
            && CryptoProvider::get_default().is_none()
        {
            return Err(SearchError::ClientBuild);
        }
        let http = reqwest::Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(SEARCH_DEADLINE)
            .https_only(https_only)
            .pool_max_idle_per_host(4)
            .user_agent(concat!(
                env!("CARGO_PKG_NAME"),
                "/",
                env!("CARGO_PKG_VERSION")
            ))
            .build()
            .map_err(|_| SearchError::ClientBuild)?;
        Ok(Self { http, endpoint })
    }

    /// Searches Innertube while selecting cancellation at every network stage.
    pub async fn search(
        &self,
        query: &str,
        cancellation: &CancellationToken,
    ) -> Result<SearchResponse, SearchError> {
        tokio::select! {
            biased;
            () = cancellation.cancelled() => Err(SearchError::Cancelled),
            result = tokio::time::timeout(SEARCH_DEADLINE, self.fetch(query, cancellation)) => {
                result.unwrap_or(Err(SearchError::DeadlineExceeded))
            }
        }
    }

    async fn fetch(
        &self,
        query: &str,
        cancellation: &CancellationToken,
    ) -> Result<SearchResponse, SearchError> {
        let request = self
            .http
            .post(self.endpoint.clone())
            .header("x-goog-fieldmask", FIELD_MASK)
            .header("x-youtube-client-name", "1")
            .header("x-youtube-client-version", CLIENT_VERSION)
            .json(&serde_json::json!({
                "context": { "client": {
                    "clientName": "WEB",
                    "clientVersion": CLIENT_VERSION,
                    "gl": "US",
                    "hl": "en"
                }},
                "params": VIDEO_FILTER,
                "query": query
            }));
        let response = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(SearchError::Cancelled),
            response = request.send() => response.map_err(|error| map_reqwest_error(&error))?,
        };
        if response.status() < StatusCode::OK || response.status() >= StatusCode::MULTIPLE_CHOICES {
            return Err(SearchError::ExtractorFailed);
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAXIMUM_RESPONSE_BYTES_U64)
        {
            return Err(SearchError::ExtractorFailed);
        }
        let mut body = Vec::new();
        body.try_reserve(MAXIMUM_RESPONSE_BYTES)
            .map_err(|_| SearchError::ExtractorFailed)?;
        let mut chunks = response.bytes_stream();
        loop {
            let next = tokio::select! {
                biased;
                () = cancellation.cancelled() => return Err(SearchError::Cancelled),
                chunk = chunks.next() => chunk,
            };
            let Some(chunk) = next else { break };
            let chunk = chunk.map_err(|error| map_reqwest_error(&error))?;
            let next_length = body
                .len()
                .checked_add(chunk.len())
                .ok_or(SearchError::ExtractorFailed)?;
            if next_length > MAXIMUM_RESPONSE_BYTES {
                return Err(SearchError::ExtractorFailed);
            }
            body.extend_from_slice(&chunk);
        }
        parse_response(&body)
    }
}

fn map_reqwest_error(error: &reqwest::Error) -> SearchError {
    if error.is_timeout() {
        SearchError::DeadlineExceeded
    } else {
        SearchError::ExtractorFailed
    }
}
