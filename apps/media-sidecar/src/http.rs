use std::time::{Duration, Instant};

use axum::{
    Json,
    body::{Body, to_bytes},
    http::{HeaderMap, Request, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    model::API_VERSION,
    observation::{CounterDelta, ObservationEvent, Observer, Outcome, Stage},
    operations::RegistryError,
    resolve::{ResolveError, ResolveResponse},
    search::{SearchError, SearchResponse},
};

const MAXIMUM_REQUEST_BYTES: usize = 16 * 1024;
const CORRELATION_HEADER: &str = "x-media-sidecar-correlation-id";

pub(crate) async fn decode<T>(request: Request<Body>) -> Result<T, ApiError>
where
    T: for<'de> Deserialize<'de>,
{
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        != Some("application/json")
    {
        return Err(ApiError::UnsupportedMediaType);
    }
    if request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAXIMUM_REQUEST_BYTES)
    {
        return Err(ApiError::PayloadTooLarge);
    }
    let bytes = to_bytes(request.into_body(), MAXIMUM_REQUEST_BYTES)
        .await
        .map_err(|_| ApiError::PayloadTooLarge)?;
    serde_json::from_slice(&bytes).map_err(|_| ApiError::InvalidRequest)
}

pub(crate) fn correlation_id(headers: &HeaderMap) -> Result<Uuid, ApiError> {
    headers
        .get(CORRELATION_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| Uuid::parse_str(value).ok())
        .ok_or(ApiError::InvalidRequest)
}

pub(crate) const fn search_outcome(result: &Result<SearchResponse, SearchError>) -> Outcome {
    match result {
        Ok(_) => Outcome::Success,
        Err(SearchError::Cancelled) => Outcome::Cancelled,
        Err(SearchError::DeadlineExceeded) => Outcome::Deadline,
        Err(SearchError::ClientBuild | SearchError::ExtractorFailed) => Outcome::Failure,
    }
}

pub(crate) const fn resolve_outcome(result: &Result<ResolveResponse, ResolveError>) -> Outcome {
    match result {
        Ok(_) => Outcome::Success,
        Err(ResolveError::Cancelled) => Outcome::Cancelled,
        Err(ResolveError::Deadline) => Outcome::Deadline,
        Err(
            ResolveError::InvalidRequest
            | ResolveError::ExtractorFailed
            | ResolveError::OutputLimit
            | ResolveError::InvalidOutput
            | ResolveError::Internal,
        ) => Outcome::Failure,
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum ApiError {
    InvalidRequest,
    PayloadTooLarge,
    UnsupportedMediaType,
    Busy,
    Internal,
    ExtractorFailed,
    DeadlineExceeded,
}

impl ApiError {
    const fn status(self) -> StatusCode {
        match self {
            Self::InvalidRequest => StatusCode::BAD_REQUEST,
            Self::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::UnsupportedMediaType => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Self::Busy => StatusCode::TOO_MANY_REQUESTS,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
            Self::ExtractorFailed => StatusCode::BAD_GATEWAY,
            Self::DeadlineExceeded => StatusCode::GATEWAY_TIMEOUT,
        }
    }

    const fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::PayloadTooLarge => "payload_too_large",
            Self::UnsupportedMediaType => "unsupported_media_type",
            Self::Busy => "busy",
            Self::Internal => "internal",
            Self::ExtractorFailed => "extractor_failed",
            Self::DeadlineExceeded => "deadline_exceeded",
        }
    }
}

#[derive(Serialize)]
struct ErrorEnvelope {
    version: u8,
    error: ErrorCode,
}

#[derive(Serialize)]
struct ErrorCode {
    code: &'static str,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status(),
            Json(ErrorEnvelope {
                version: API_VERSION,
                error: ErrorCode { code: self.code() },
            }),
        )
            .into_response()
    }
}

impl From<RegistryError> for ApiError {
    fn from(error: RegistryError) -> Self {
        match error {
            RegistryError::Busy => Self::Busy,
            RegistryError::Internal => Self::Internal,
        }
    }
}

impl From<SearchError> for ApiError {
    fn from(error: SearchError) -> Self {
        match error {
            SearchError::DeadlineExceeded => Self::DeadlineExceeded,
            SearchError::ExtractorFailed => Self::ExtractorFailed,
            SearchError::ClientBuild | SearchError::Cancelled => Self::Internal,
        }
    }
}

impl From<ResolveError> for ApiError {
    fn from(error: ResolveError) -> Self {
        match error {
            ResolveError::InvalidRequest => Self::InvalidRequest,
            ResolveError::Deadline => Self::DeadlineExceeded,
            ResolveError::ExtractorFailed
            | ResolveError::OutputLimit
            | ResolveError::InvalidOutput => Self::ExtractorFailed,
            ResolveError::Cancelled | ResolveError::Internal => Self::Internal,
        }
    }
}

pub(crate) struct HandlerObservation {
    correlation_id: Uuid,
    observer: Observer,
    started: Instant,
    completed: bool,
}

impl HandlerObservation {
    pub(crate) fn new(correlation_id: Uuid, observer: Observer) -> Self {
        observer.emit(ObservationEvent::new(
            correlation_id,
            Stage::RustHandler,
            Outcome::Started,
            Duration::ZERO,
            CounterDelta::INCREMENT,
        ));
        Self {
            correlation_id,
            observer,
            started: Instant::now(),
            completed: false,
        }
    }

    pub(crate) fn finish(&mut self, error: ApiError) -> Response {
        self.emit_terminal(Outcome::Failure);
        error.into_response()
    }

    pub(crate) fn success(&mut self, response: Response) -> Response {
        self.emit_terminal(Outcome::Success);
        response
    }

    fn emit_terminal(&mut self, outcome: Outcome) {
        self.observer.emit(ObservationEvent::new(
            self.correlation_id,
            Stage::RustHandler,
            outcome,
            self.started.elapsed(),
            CounterDelta::DECREMENT,
        ));
        self.completed = true;
    }
}

impl Drop for HandlerObservation {
    fn drop(&mut self) {
        if !self.completed {
            self.observer.emit(ObservationEvent::new(
                self.correlation_id,
                Stage::RustHandler,
                Outcome::Cancelled,
                self.started.elapsed(),
                CounterDelta::DECREMENT,
            ));
        }
    }
}
