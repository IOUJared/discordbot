use serde::Deserialize;
use serde_json::Value;
use url::Url;

use super::{SearchError, SearchResponse, SearchResult, Track};

const MAXIMUM_RENDERERS: usize = 5;

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

pub(super) fn parse_response(body: &[u8]) -> Result<SearchResponse, SearchError> {
    let raw: Value = serde_json::from_slice(body).map_err(|_| SearchError::ExtractorFailed)?;
    let mut candidates = Vec::with_capacity(MAXIMUM_RENDERERS);
    collect_renderers(&raw, &mut candidates);
    let results = candidates
        .into_iter()
        .enumerate()
        .filter_map(|(ordinal, candidate)| normalize_renderer(candidate, ordinal))
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
    let text = text
        .runs
        .iter()
        .map(|run| run.text.as_str())
        .collect::<String>();
    let text = text.trim_matches(is_ecmascript_whitespace);
    if text.is_empty() || text.encode_utf16().count() > 512 {
        return None;
    }
    Some(text.to_owned())
}

const fn is_ecmascript_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'
            | '\u{000a}'
            | '\u{000b}'
            | '\u{000c}'
            | '\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
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
