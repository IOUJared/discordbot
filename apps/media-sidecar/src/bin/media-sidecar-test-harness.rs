//! Feature-gated process entry point for deterministic sidecar integration tests.

use std::{env, path::PathBuf, process::ExitCode};

use discord_music_media_sidecar::{config::Settings, test_support};
use url::Url;

fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .json()
        .with_current_span(false)
        .with_span_list(false)
        .with_target(false)
        .init();
    match execute() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(code = %error, "test_harness_failed");
            ExitCode::FAILURE
        }
    }
}

fn execute() -> Result<(), HarnessError> {
    let settings = Settings::from_env().map_err(|_| HarnessError::Configuration)?;
    let endpoint = env::var("SIDECAR_TEST_UPSTREAM")
        .map_err(|_| HarnessError::Configuration)
        .and_then(|value| Url::parse(&value).map_err(|_| HarnessError::Configuration))?;
    let resolver = env::var_os("SIDECAR_TEST_YT_DLP")
        .map_or_else(|| PathBuf::from("/usr/local/bin/yt-dlp"), PathBuf::from);
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|_| HarnessError::Runtime)?
        .block_on(test_support::run(settings, endpoint, resolver))
        .map_err(|_| HarnessError::Service)
}

#[derive(Debug, thiserror::Error)]
enum HarnessError {
    #[error("configuration")]
    Configuration,
    #[error("runtime")]
    Runtime,
    #[error("service")]
    Service,
}
