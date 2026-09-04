//! Process entry point for the private media sidecar.

use std::{
    env,
    io::{self, Write as _},
    process::ExitCode,
};

use discord_music_media_sidecar::{config::Settings, error::ServiceError};
const VERSION: &str = concat!(
    env!("CARGO_PKG_NAME"),
    " ",
    env!("CARGO_PKG_VERSION"),
    " (",
    env!("SIDECAR_RUSTC_VERSION"),
    ", build ",
    env!("SIDECAR_BUILD_REVISION"),
    ")\n"
);

fn main() -> ExitCode {
    match execute() {
        Ok(()) => ExitCode::SUCCESS,
        Err(ServiceError::Configuration(error)) => {
            let message = format!("media sidecar configuration error: {error}\n");
            let _ignored = io::stderr().lock().write_all(message.as_bytes());
            ExitCode::FAILURE
        }
        Err(error) => {
            tracing::error!(code = %error, "service_failed");
            ExitCode::FAILURE
        }
    }
}

fn execute() -> Result<(), ServiceError> {
    if env::args_os()
        .nth(1)
        .is_some_and(|argument| argument == "--version")
    {
        io::stdout()
            .lock()
            .write_all(VERSION.as_bytes())
            .map_err(ServiceError::ProcessOutput)?;
        return Ok(());
    }

    tracing_subscriber::fmt()
        .json()
        .with_current_span(false)
        .with_span_list(false)
        .with_target(false)
        .try_init()
        .map_err(|error| ServiceError::ProcessOutput(io::Error::other(error.to_string())))?;
    let settings = Settings::from_env()?;
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(ServiceError::RuntimeInit)?
        .block_on(discord_music_media_sidecar::run(settings))
}
