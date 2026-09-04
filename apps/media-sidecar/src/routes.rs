use axum::{Router, body::Body, http::Request, routing::get};
use tower_http::trace::TraceLayer;

use crate::model::HealthResponse;

/// Builds the private router without extractor endpoints.
pub fn router() -> Router {
    Router::new()
        .route("/healthz", get(health))
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

async fn health() -> axum::Json<HealthResponse> {
    axum::Json(HealthResponse::healthy())
}
