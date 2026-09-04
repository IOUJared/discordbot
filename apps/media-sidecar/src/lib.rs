//! Private HTTP service foundation for media extraction.

use std::{future::IntoFuture as _, time::Duration};

use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use crate::{config::Settings, error::ServiceError};

/// Validated environment configuration.
pub mod config;
/// Typed sanitized lifecycle errors.
pub mod error;
/// Versioned private protocol models.
pub mod model;
/// Private HTTP route composition.
pub mod routes;

const SHUTDOWN_DRAIN: Duration = Duration::from_secs(10);

/// Runs the private server until SIGINT/SIGTERM and bounds connection draining.
pub async fn run(settings: Settings) -> Result<(), ServiceError> {
    let mut signals = ShutdownSignals::install()?;
    let listener = TcpListener::bind(settings.address())
        .await
        .map_err(ServiceError::ListenerBind)?;
    let listen_address = listener.local_addr().map_err(ServiceError::ListenerBind)?;
    tracing::info!(%listen_address, "listener_ready");

    let shutdown = CancellationToken::new();
    let graceful = shutdown.clone();
    let server = axum::serve(listener, routes::router())
        .with_graceful_shutdown(async move { graceful.cancelled_owned().await })
        .into_future();
    tokio::pin!(server);

    tokio::select! {
        result = &mut server => result.map_err(ServiceError::HttpServe),
        signal = signals.recv() => {
            let signal = signal?;
            tracing::info!(signal = signal.name(), "shutdown_started");
            shutdown.cancel();
            tokio::time::timeout(SHUTDOWN_DRAIN, &mut server)
                .await
                .map_err(|_| ServiceError::ShutdownTimeout)?
                .map_err(ServiceError::HttpServe)?;
            tracing::info!("shutdown_complete");
            Ok(())
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum ShutdownSignal {
    Interrupt,
    Terminate,
}

impl ShutdownSignal {
    const fn name(self) -> &'static str {
        match self {
            Self::Interrupt => "sigint",
            Self::Terminate => "sigterm",
        }
    }
}

#[cfg(unix)]
#[derive(Debug)]
struct ShutdownSignals {
    interrupt: tokio::signal::unix::Signal,
    terminate: tokio::signal::unix::Signal,
}

#[cfg(unix)]
impl ShutdownSignals {
    fn install() -> Result<Self, ServiceError> {
        let interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
            .map_err(ServiceError::SignalInstall)?;
        let terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .map_err(ServiceError::SignalInstall)?;
        Ok(Self {
            interrupt,
            terminate,
        })
    }

    async fn recv(&mut self) -> Result<ShutdownSignal, ServiceError> {
        tokio::select! {
            interrupt = self.interrupt.recv() => interrupt
                .map(|()| ShutdownSignal::Interrupt)
                .ok_or(ServiceError::SignalStreamClosed),
            terminate = self.terminate.recv() => terminate
                .map(|()| ShutdownSignal::Terminate)
                .ok_or(ServiceError::SignalStreamClosed),
        }
    }
}

#[cfg(not(unix))]
#[derive(Debug)]
struct ShutdownSignals;

#[cfg(not(unix))]
impl ShutdownSignals {
    const fn install() -> Result<Self, ServiceError> {
        Ok(Self)
    }

    async fn recv(&mut self) -> Result<ShutdownSignal, ServiceError> {
        tokio::signal::ctrl_c()
            .await
            .map_err(ServiceError::SignalInstall)?;
        Ok(ShutdownSignal::Interrupt)
    }
}
