use std::time::Duration;

use serde::Serialize;
use tokio::sync::mpsc;
use uuid::Uuid;

const SCHEMA: &str = "media_sidecar_observation.v1";
#[cfg(feature = "test-upstream")]
const TEST_EVENT_CAPACITY: usize = 2_048;

/// A bounded millisecond duration safe for private structured events.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct DurationMillis(u32);

impl DurationMillis {
    fn from_duration(duration: Duration) -> Self {
        u32::try_from(duration.as_millis()).map_or(Self(u32::MAX), Self)
    }
}

/// The allowlisted extractor boundary that emitted an observation.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum Stage {
    /// Private Rust HTTP handling.
    RustHandler,
    /// Fixed `YouTube` Innertube provider request.
    InnertubeUpstream,
    /// Bounded yt-dlp child process.
    YtDlp,
    /// Supervised in-flight operation registry.
    Registry,
    /// Bounded service shutdown drain.
    ShutdownDrain,
}

/// The allowlisted terminal or transition outcome.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum Outcome {
    /// Work began.
    Started,
    /// Work completed successfully.
    Success,
    /// Work failed with a sanitized typed error.
    Failure,
    /// Work was cancelled by its caller.
    Cancelled,
    /// Work exhausted its fixed deadline.
    Deadline,
}

/// A bounded counter adjustment carried by an observation.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct CounterDelta(i8);

impl CounterDelta {
    /// Increments an in-flight or completion counter.
    pub const INCREMENT: Self = Self(1);
    /// Decrements an in-flight counter.
    pub const DECREMENT: Self = Self(-1);
}

/// Payload-free private correlation event for extractor operations.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationEvent {
    schema: &'static str,
    correlation_id: Uuid,
    stage: Stage,
    outcome: Outcome,
    duration_ms: DurationMillis,
    counter_delta: CounterDelta,
}

impl ObservationEvent {
    /// Creates an event containing only the allowlisted private fields.
    pub fn new(
        correlation_id: Uuid,
        stage: Stage,
        outcome: Outcome,
        duration: Duration,
        counter_delta: CounterDelta,
    ) -> Self {
        Self {
            schema: SCHEMA,
            correlation_id,
            stage,
            outcome,
            duration_ms: DurationMillis::from_duration(duration),
            counter_delta,
        }
    }
}

#[derive(Clone)]
#[doc(hidden)]
pub struct Observer {
    recorded: Option<mpsc::Sender<ObservationEvent>>,
}

impl std::fmt::Debug for Observer {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Observer")
            .field("recording", &self.recorded.is_some())
            .finish()
    }
}

impl Observer {
    pub(crate) const fn production() -> Self {
        Self { recorded: None }
    }

    #[cfg(feature = "test-upstream")]
    pub(crate) fn recording() -> (Self, mpsc::Receiver<ObservationEvent>) {
        let (sender, receiver) = mpsc::channel(TEST_EVENT_CAPACITY);
        (
            Self {
                recorded: Some(sender),
            },
            receiver,
        )
    }

    pub(crate) fn emit(&self, event: ObservationEvent) {
        if let Ok(serialized) = serde_json::to_string(&event) {
            tracing::info!(observation = serialized, "media_sidecar_observation");
        } else {
            tracing::warn!("observation_serialization_failed");
        }
        if let Some(recorded) = &self.recorded {
            let _ignored = recorded.try_send(event);
        }
    }
}
