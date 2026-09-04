use std::{collections::BTreeMap, ffi::OsString, path::PathBuf, time::Duration};

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::process::{self, ProcessError, ProcessSpec};

const API_VERSION: u8 = 1;
const RESOLVE_DEADLINE: Duration = Duration::from_secs(20);
const YT_DLP: &str = "/usr/local/bin/yt-dlp";

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResolveRequest {
    pub version: u8,
    pub track: TrackRequest,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrackRequest {
    pub id: String,
    pub url: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ResolveResponse {
    pub version: u8,
    pub media: RemoteMedia,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMedia {
    pub kind: &'static str,
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub container: String,
    pub codec: String,
    pub bitrate_kbps: Option<u32>,
    pub seekable: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum ResolveError {
    #[error("invalid_request")]
    InvalidRequest,
    #[error("extractor_failed")]
    ExtractorFailed,
    #[error("deadline_exceeded")]
    Deadline,
    #[error("cancelled")]
    Cancelled,
    #[error("output_limit")]
    OutputLimit,
    #[error("invalid_resolve_output")]
    InvalidOutput,
    #[error("internal")]
    Internal,
}

#[derive(Clone, Debug)]
pub struct Resolver {
    executable: PathBuf,
    deadline: Duration,
    cookies: Option<PathBuf>,
}

impl Resolver {
    pub fn production(cookies: Option<PathBuf>) -> Self {
        Self {
            executable: PathBuf::from(YT_DLP),
            deadline: RESOLVE_DEADLINE,
            cookies,
        }
    }

    #[cfg(test)]
    pub const fn for_test(
        executable: PathBuf,
        deadline: Duration,
        cookies: Option<PathBuf>,
    ) -> Self {
        Self {
            executable,
            deadline,
            cookies,
        }
    }

    pub async fn resolve(
        &self,
        request: &ResolveRequest,
        cancelled: CancellationToken,
    ) -> Result<ResolveResponse, ResolveError> {
        validate_request(request)?;
        let arguments = arguments(request, self.cookies.as_deref());
        let output = process::execute(
            ProcessSpec {
                executable: &self.executable,
                arguments: &arguments,
                deadline: self.deadline,
            },
            cancelled,
        )
        .await
        .map_err(map_process_error)?;
        parse_output(&output.stdout)
    }
}

fn validate_request(request: &ResolveRequest) -> Result<(), ResolveError> {
    if request.version != API_VERSION || request.track.id.is_empty() || request.track.id.len() > 128
    {
        return Err(ResolveError::InvalidRequest);
    }
    if !request
        .track
        .id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(ResolveError::InvalidRequest);
    }
    if request.track.url != format!("https://www.youtube.com/watch?v={}", request.track.id) {
        return Err(ResolveError::InvalidRequest);
    }
    Ok(())
}

fn arguments(request: &ResolveRequest, cookies: Option<&std::path::Path>) -> Vec<OsString> {
    let mut values = vec![
        "--ignore-config".into(),
        "--proxy".into(),
        "".into(),
        "--js-runtimes".into(),
        "deno:/usr/local/bin/deno".into(),
    ];
    if let Some(path) = cookies {
        values.push("--cookies".into());
        values.push(path.as_os_str().to_owned());
    }
    values.extend([
        "--no-playlist".into(),
        "--no-warnings".into(),
        "-f".into(),
        "bestaudio".into(),
        "--print".into(),
        "%(.{url,http_headers,ext,acodec,abr,protocol})#j".into(),
        request.track.url.as_str().into(),
    ]);
    values
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawMedia {
    url: String,
    #[serde(default)]
    http_headers: BTreeMap<String, String>,
    ext: String,
    acodec: String,
    abr: Option<f64>,
    protocol: String,
}

fn parse_output(bytes: &[u8]) -> Result<ResolveResponse, ResolveError> {
    let raw: RawMedia = serde_json::from_slice(bytes).map_err(|_| ResolveError::InvalidOutput)?;
    if raw.ext.is_empty()
        || raw.acodec.is_empty()
        || !matches!(raw.protocol.as_str(), "http" | "https")
    {
        return Err(ResolveError::InvalidOutput);
    }
    let url = url::Url::parse(&raw.url).map_err(|_| ResolveError::InvalidOutput)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || !url
            .host_str()
            .is_some_and(|host| host == "googlevideo.com" || host.ends_with(".googlevideo.com"))
        || !safe_headers(&raw.http_headers)
    {
        return Err(ResolveError::InvalidOutput);
    }
    let bitrate_kbps = raw
        .abr
        .map(|value| {
            if !value.is_finite() || value <= 0.0 || value > f64::from(u32::MAX) {
                return Err(ResolveError::InvalidOutput);
            }
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "positive u32 range and finiteness checked above"
            )]
            Ok(value.round() as u32)
        })
        .transpose()?;
    Ok(ResolveResponse {
        version: API_VERSION,
        media: RemoteMedia {
            kind: "remote",
            url: raw.url,
            headers: raw.http_headers,
            container: raw.ext,
            codec: raw.acodec,
            bitrate_kbps,
            seekable: true,
        },
    })
}

fn safe_headers(headers: &BTreeMap<String, String>) -> bool {
    const FORBIDDEN: [&str; 5] = [
        "host",
        "connection",
        "content-length",
        "proxy-authorization",
        "transfer-encoding",
    ];
    headers.iter().all(|(name, value)| {
        !name.is_empty()
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
            && !value.contains(['\r', '\n'])
            && !FORBIDDEN
                .iter()
                .any(|forbidden| name.eq_ignore_ascii_case(forbidden))
    })
}

const fn map_process_error(error: ProcessError) -> ResolveError {
    match error {
        ProcessError::Failed => ResolveError::ExtractorFailed,
        ProcessError::Deadline => ResolveError::Deadline,
        ProcessError::Cancelled => ResolveError::Cancelled,
        ProcessError::OutputLimit => ResolveError::OutputLimit,
        ProcessError::Spawn | ProcessError::SupervisorClosed => ResolveError::Internal,
    }
}
