// allow: SIZE_OK — this file is the single bounded Innertube boundary until route wiring.
use std::time::Duration;

use futures_util::StreamExt as _;
use reqwest::{StatusCode, redirect::Policy};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use url::Url;

const PRODUCTION_ENDPOINT: &str = "https://www.youtube.com/youtubei/v1/search";
const CLIENT_VERSION: &str = "2.20240101.00.00";
const VIDEO_FILTER: &str = "EgIQAQ%3D%3D";
const FIELD_MASK: &str = "contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents.itemSectionRenderer.contents.videoRenderer.videoId,contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents.itemSectionRenderer.contents.videoRenderer.title,contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents.itemSectionRenderer.contents.videoRenderer.ownerText,contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents.itemSectionRenderer.contents.videoRenderer.lengthText,contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents.itemSectionRenderer.contents.videoRenderer.thumbnail";
const CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
const SEARCH_DEADLINE: Duration = Duration::from_millis(2_500);
const MAXIMUM_RENDERERS: usize = 5;
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VideoRenderer {
    video_id: String,
    title: TextRuns,
    owner_text: TextRuns,
    length_text: LengthText,
    thumbnail: Thumbnails,
}

#[derive(Deserialize)]
struct TextRuns {
    runs: Vec<TextRun>,
}

#[derive(Deserialize)]
struct TextRun {
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LengthText {
    simple_text: String,
}

#[derive(Deserialize)]
struct Thumbnails {
    thumbnails: Vec<Thumbnail>,
}

#[derive(Deserialize)]
struct Thumbnail {
    url: String,
}

fn map_reqwest_error(error: &reqwest::Error) -> SearchError {
    if error.is_timeout() {
        SearchError::DeadlineExceeded
    } else {
        SearchError::ExtractorFailed
    }
}

fn parse_response(body: &[u8]) -> Result<SearchResponse, SearchError> {
    let raw: Value = serde_json::from_slice(body).map_err(|_| SearchError::ExtractorFailed)?;
    let mut candidates = Vec::with_capacity(MAXIMUM_RENDERERS);
    collect_renderers(&raw, &mut candidates);
    let results = candidates
        .into_iter()
        .enumerate()
        .find_map(|(ordinal, candidate)| normalize_renderer(candidate, ordinal))
        .into_iter()
        .collect();
    Ok(SearchResponse {
        version: crate::model::API_VERSION,
        results,
    })
}

fn collect_renderers<'a>(value: &'a Value, output: &mut Vec<&'a Value>) {
    if output.len() >= MAXIMUM_RENDERERS {
        return;
    }
    match value {
        Value::Array(values) => {
            for value in values {
                collect_renderers(value, output);
                if output.len() >= MAXIMUM_RENDERERS {
                    break;
                }
            }
        }
        Value::Object(object) => {
            if let Some(renderer) = object.get("videoRenderer") {
                output.push(renderer);
                return;
            }
            for value in object.values() {
                collect_renderers(value, output);
                if output.len() >= MAXIMUM_RENDERERS {
                    break;
                }
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
}

fn normalize_renderer(value: &Value, ordinal: usize) -> Option<SearchResult> {
    let renderer: VideoRenderer = serde_json::from_value(value.clone()).ok()?;
    if renderer.video_id.is_empty()
        || renderer.video_id.len() > 128
        || !renderer
            .video_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return None;
    }
    let title = concatenate_runs(&renderer.title)?;
    let artist = concatenate_runs(&renderer.owner_text)?;
    let duration_ms = parse_duration_ms(&renderer.length_text.simple_text)?;
    let artwork_url = renderer.thumbnail.thumbnails.last()?.url.clone();
    let artwork = Url::parse(&artwork_url).ok()?;
    if !matches!(artwork.scheme(), "http" | "https") {
        return None;
    }
    Some(SearchResult {
        track: Track {
            url: format!("https://www.youtube.com/watch?v={}", renderer.video_id),
            id: renderer.video_id,
            provider: "youtube".to_owned(),
            title,
            artist,
            duration_ms,
            artwork_url,
        },
        score: ordinal_score(ordinal),
        bitrate_kbps: None,
    })
}

fn concatenate_runs(text: &TextRuns) -> Option<String> {
    if text.runs.is_empty() || text.runs.iter().any(|run| run.text.is_empty()) {
        return None;
    }
    Some(text.runs.iter().map(|run| run.text.as_str()).collect())
}

fn parse_duration_ms(value: &str) -> Option<u64> {
    let mut count = 0_u8;
    let seconds = value.split(':').try_fold(0_u64, |total, part| {
        count = count.checked_add(1)?;
        let component = part.parse::<u64>().ok()?;
        total.checked_mul(60)?.checked_add(component)
    })?;
    if count < 2 {
        return None;
    }
    seconds.checked_mul(1_000)
}

const fn ordinal_score(ordinal: usize) -> f64 {
    match ordinal {
        0 => 1.0,
        1 => 0.9,
        2 => 0.8,
        3 => 0.7,
        4 => 0.6,
        _ => 0.0,
    }
}
