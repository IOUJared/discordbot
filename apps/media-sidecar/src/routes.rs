use std::time::{Duration, Instant};

#[cfg(feature = "test-upstream")]
use std::path::PathBuf;

use axum::{
    Json, Router,
    body::Body,
    extract::State,
    http::Request,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use tower_http::trace::TraceLayer;
use uuid::Uuid;

#[cfg(feature = "test-upstream")]
use url::Url;

use crate::{
    http::{ApiError, HandlerObservation, correlation_id, decode, resolve_outcome, search_outcome},
    model::{API_VERSION, HealthResponse},
    observation::{CounterDelta, ObservationEvent, Observer, Outcome, Stage},
    operations::{OperationRegistry, RegistryError},
    resolve::{ResolveRequest, Resolver},
    search::{SearchClient, SearchError},
};

#[derive(Clone, Debug)]
pub(crate) struct RouteState {
    registry: OperationRegistry,
    search: SearchClient,
    resolver: Resolver,
    observer: Observer,
}

impl RouteState {
    pub(crate) fn production() -> Result<Self, SearchError> {
        Ok(Self::new(
            SearchClient::new()?,
            Resolver::production(None),
            Observer::production(),
        ))
    }

    #[cfg(feature = "test-upstream")]
    pub(crate) fn for_test(
        endpoint: Url,
        resolver_executable: PathBuf,
        resolver_deadline: Duration,
        observer: Observer,
    ) -> Result<Self, SearchError> {
        Ok(Self::new(
            SearchClient::for_test(endpoint)?,
            Resolver::for_test(resolver_executable, resolver_deadline, None),
            observer,
        ))
    }

    fn new(search: SearchClient, resolver: Resolver, observer: Observer) -> Self {
        Self {
            registry: OperationRegistry::new(observer.clone()),
            search,
            resolver,
            observer,
        }
    }

    pub(crate) async fn stop_admission(&self) {
        self.registry.stop_admission().await;
    }

    pub(crate) async fn shutdown(&self, correlation_id: Uuid) -> Result<(), RegistryError> {
        self.registry.shutdown(correlation_id).await
    }

    #[cfg(feature = "test-upstream")]
    pub(crate) async fn wait_for_active(&self, expected: usize) -> Result<(), RegistryError> {
        self.registry.wait_for_active(expected).await
    }
}

pub(crate) fn router(state: RouteState) -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/v1/search", post(search))
        .route("/v1/resolve", post(resolve))
        .with_state(state)
        .layer(
            TraceLayer::new_for_http().make_span_with(|request: &Request<Body>| {
                tracing::info_span!(
                    "http_request",
                    method = %request.method(),
                    path = request.uri().path()
                )
            }),
        )
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse::healthy())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchRequest {
    version: u8,
    query: String,
}

async fn search(State(state): State<RouteState>, request: Request<Body>) -> Response {
    let correlation_id = match correlation_id(request.headers()) {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let mut observation = HandlerObservation::new(correlation_id, state.observer.clone());
    let request = match decode::<SearchRequest>(request).await {
        Ok(value)
            if value.version == API_VERSION
                && !value.query.is_empty()
                && value.query.len() <= 512 =>
        {
            value
        }
        Ok(_) | Err(ApiError::InvalidRequest) => {
            return observation.finish(ApiError::InvalidRequest);
        }
        Err(error) => return observation.finish(error),
    };
    let client = state.search.clone();
    let observer = state.observer.clone();
    let operation = state
        .registry
        .start(correlation_id, move |token| async move {
            let started = Instant::now();
            observer.emit(ObservationEvent::new(
                correlation_id,
                Stage::InnertubeUpstream,
                Outcome::Started,
                Duration::ZERO,
                CounterDelta::INCREMENT,
            ));
            let result = client.search(&request.query, &token).await;
            observer.emit(ObservationEvent::new(
                correlation_id,
                Stage::InnertubeUpstream,
                search_outcome(&result),
                started.elapsed(),
                CounterDelta::DECREMENT,
            ));
            result
        })
        .await;
    let operation = match operation {
        Ok(value) => value,
        Err(error) => return observation.finish(error.into()),
    };
    match operation.wait().await {
        Ok(Ok(response)) => observation.success(Json(response).into_response()),
        Ok(Err(error)) => observation.finish(error.into()),
        Err(error) => observation.finish(error.into()),
    }
}

async fn resolve(State(state): State<RouteState>, request: Request<Body>) -> Response {
    let correlation_id = match correlation_id(request.headers()) {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let mut observation = HandlerObservation::new(correlation_id, state.observer.clone());
    let request = match decode::<ResolveRequest>(request).await {
        Ok(value) => value,
        Err(error) => return observation.finish(error),
    };
    if let Err(error) = request.validate() {
        return observation.finish(error.into());
    }
    let resolver = state.resolver.clone();
    let observer = state.observer.clone();
    let operation = state
        .registry
        .start(correlation_id, move |token| async move {
            let started = Instant::now();
            observer.emit(ObservationEvent::new(
                correlation_id,
                Stage::YtDlp,
                Outcome::Started,
                Duration::ZERO,
                CounterDelta::INCREMENT,
            ));
            let result = resolver.resolve(&request, token).await;
            observer.emit(ObservationEvent::new(
                correlation_id,
                Stage::YtDlp,
                resolve_outcome(&result),
                started.elapsed(),
                CounterDelta::DECREMENT,
            ));
            result
        })
        .await;
    let operation = match operation {
        Ok(value) => value,
        Err(error) => return observation.finish(error.into()),
    };
    match operation.wait().await {
        Ok(Ok(response)) => observation.success(Json(response).into_response()),
        Ok(Err(error)) => observation.finish(error.into()),
        Err(error) => observation.finish(error.into()),
    }
}
