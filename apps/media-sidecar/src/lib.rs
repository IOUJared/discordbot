//! Private HTTP service foundation for media extraction.

use std::{future::IntoFuture as _, io, time::Duration};

use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{config::Settings, error::ServiceError};

/// Validated environment configuration.
pub mod config;
/// Typed sanitized lifecycle errors.
pub mod error;
#[doc(hidden)]
pub mod http;
/// Versioned private protocol models.
pub mod model;
/// Payload-free private observation schema.
pub mod observation;
#[doc(hidden)]
pub mod operations;
#[doc(hidden)]
pub mod process;
#[doc(hidden)]
pub mod resolve;
#[doc(hidden)]
pub mod routes;
#[doc(hidden)]
pub mod search;

const SHUTDOWN_DRAIN: Duration = Duration::from_secs(10);

/// Runs the private server until SIGINT/SIGTERM and bounds connection draining.
pub async fn run(settings: Settings) -> Result<(), ServiceError> {
    let state = routes::RouteState::production()
        .map_err(|error| ServiceError::RuntimeInit(io::Error::other(error.to_string())))?;
    run_with_state(settings, state).await
}

async fn run_with_state(settings: Settings, state: routes::RouteState) -> Result<(), ServiceError> {
    let mut signals = ShutdownSignals::install()?;
    let listener = TcpListener::bind(settings.address())
        .await
        .map_err(ServiceError::ListenerBind)?;
    let listen_address = listener.local_addr().map_err(ServiceError::ListenerBind)?;
    tracing::info!(%listen_address, "listener_ready");

    let shutdown = CancellationToken::new();
    let graceful = shutdown.clone();
    let server = axum::serve(listener, routes::router(state.clone()))
        .with_graceful_shutdown(async move { graceful.cancelled_owned().await })
        .into_future();
    tokio::pin!(server);

    tokio::select! {
        result = &mut server => {
            state.shutdown(Uuid::new_v4()).await
                .map_err(|error| ServiceError::RuntimeInit(io::Error::other(error.to_string())))?;
            result.map_err(ServiceError::HttpServe)
        },
        signal = signals.recv() => {
            let signal = signal?;
            tracing::info!(signal = signal.name(), "shutdown_started");
            state.stop_admission().await;
            shutdown.cancel();
            tokio::time::timeout(SHUTDOWN_DRAIN, async {
                state.shutdown(Uuid::new_v4()).await
                    .map_err(|error| ServiceError::RuntimeInit(io::Error::other(error.to_string())))?;
                (&mut server).await.map_err(ServiceError::HttpServe)
            })
                .await
                .map_err(|_| ServiceError::ShutdownTimeout)??;
            tracing::info!("shutdown_complete");
            Ok(())
        }
    }
}

#[cfg(feature = "test-upstream")]
/// Feature-gated constructors and counters for deterministic black-box tests.
pub mod test_support {
    use std::{path::PathBuf, time::Duration};

    use axum::Router;
    use tokio::sync::{Mutex, mpsc};
    use url::Url;
    use uuid::Uuid;

    use crate::{
        config::Settings,
        observation::{ObservationEvent, Observer},
        operations::RegistryError,
        routes::{self, RouteState},
        search::SearchError,
    };

    /// Sanitized failures from the feature-gated test service boundary.
    #[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
    #[non_exhaustive]
    pub enum TestSupportError {
        /// A deterministic adapter could not be constructed.
        #[error("setup")]
        Setup,
        /// The supervised registry did not reach its required state.
        #[error("registry")]
        Registry,
    }

    /// An in-memory view of the real router with deterministic upstream injection.
    #[derive(Debug)]
    pub struct TestService {
        state: RouteState,
        router: Router,
        events: Mutex<mpsc::Receiver<ObservationEvent>>,
    }

    impl TestService {
        /// Builds the real router with only feature-gated test adapters replaced.
        pub fn new(
            search_endpoint: Url,
            resolver_executable: PathBuf,
            resolver_deadline: Duration,
        ) -> Result<Self, TestSupportError> {
            let (observer, events) = Observer::recording();
            let state = RouteState::for_test(
                search_endpoint,
                resolver_executable,
                resolver_deadline,
                observer,
            )
            .map_err(|_error: SearchError| TestSupportError::Setup)?;
            let router = routes::router(state.clone());
            Ok(Self {
                state,
                router,
                events: Mutex::new(events),
            })
        }

        /// Returns a clone of the assembled real router.
        pub fn router(&self) -> Router {
            self.router.clone()
        }

        /// Waits until the supervised registry has exactly the requested size.
        pub async fn wait_for_active(&self, expected: usize) -> Result<(), TestSupportError> {
            self.state
                .wait_for_active(expected)
                .await
                .map_err(|_error: RegistryError| TestSupportError::Registry)
        }

        /// Waits until every supervised operation has completed cleanup.
        pub async fn wait_for_idle(&self) -> Result<(), TestSupportError> {
            self.wait_for_active(0).await
        }

        /// Drains the bounded test observation receiver.
        pub async fn observations(&self) -> Vec<ObservationEvent> {
            let mut receiver = self.events.lock().await;
            let mut events = Vec::new();
            while let Ok(event) = receiver.try_recv() {
                events.push(event);
            }
            events
        }

        /// Stops admission, cancels operations, and joins every registry task.
        pub async fn shutdown(&self) -> Result<(), TestSupportError> {
            self.state
                .shutdown(Uuid::new_v4())
                .await
                .map_err(|_error: RegistryError| TestSupportError::Registry)
        }
    }

    /// Runs the feature-gated harness through the production signal lifecycle.
    pub async fn run(
        settings: Settings,
        search_endpoint: Url,
        resolver_executable: PathBuf,
    ) -> Result<(), crate::error::ServiceError> {
        let state = RouteState::for_test(
            search_endpoint,
            resolver_executable,
            Duration::from_secs(30),
            Observer::production(),
        )
        .map_err(|error| {
            crate::error::ServiceError::RuntimeInit(std::io::Error::other(error.to_string()))
        })?;
        crate::run_with_state(settings, state).await
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
