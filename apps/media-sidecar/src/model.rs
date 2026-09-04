use serde::Serialize;

/// Protocol version shared by every private sidecar response.
pub const API_VERSION: u8 = 1;

/// Exact response body for the private readiness endpoint.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[non_exhaustive]
pub struct HealthResponse {
    /// Private protocol version.
    pub version: u8,
    /// Fixed readiness state.
    pub status: &'static str,
}

impl HealthResponse {
    /// Creates the allocation-free healthy response.
    pub const fn healthy() -> Self {
        Self {
            version: API_VERSION,
            status: "ok",
        }
    }
}
