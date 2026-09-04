use std::io;

/// Sanitized configuration failures returned before listener startup.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum ConfigError {
    /// The listener host is not an explicitly permitted private bind host.
    #[error("SIDECAR_HOST must be 127.0.0.1 or 0.0.0.0")]
    Host,
    /// The listener port is not representable as an unsigned 16-bit port.
    #[error("SIDECAR_PORT must be an integer from 0 to 65535")]
    Port,
}

/// Typed service lifecycle failures whose diagnostics never contain request payloads.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum ServiceError {
    /// Process configuration could not be parsed.
    #[error("configuration")]
    Configuration(#[from] ConfigError),
    /// Signal handlers could not be installed.
    #[error("signal_install")]
    SignalInstall(#[source] io::Error),
    /// Every installed shutdown signal stream closed unexpectedly.
    #[error("signal_stream_closed")]
    SignalStreamClosed,
    /// The listener could not bind to its validated address.
    #[error("listener_bind")]
    ListenerBind(#[source] io::Error),
    /// The HTTP server failed while serving connections.
    #[error("http_serve")]
    HttpServe(#[source] io::Error),
    /// Graceful connection draining exceeded its fixed bound.
    #[error("shutdown_timeout")]
    ShutdownTimeout,
    /// A version or sanitized error message could not be written.
    #[error("process_output")]
    ProcessOutput(#[source] io::Error),
    /// The async runtime could not be constructed.
    #[error("runtime_init")]
    RuntimeInit(#[source] io::Error),
}
