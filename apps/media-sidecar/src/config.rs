use std::{env, net::SocketAddr};

use crate::error::ConfigError;

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: &str = "3101";

/// Validated process configuration for the private service listener.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Settings {
    address: SocketAddr,
}

impl Settings {
    /// Parses optional host and port boundary values into a socket address.
    pub fn parse(host: Option<&str>, port: Option<&str>) -> Result<Self, ConfigError> {
        let host = host.unwrap_or(DEFAULT_HOST);
        let ip = match host {
            "127.0.0.1" => [127, 0, 0, 1],
            "0.0.0.0" => [0, 0, 0, 0],
            _ => return Err(ConfigError::Host),
        };
        let port = port
            .unwrap_or(DEFAULT_PORT)
            .parse::<u16>()
            .map_err(|_| ConfigError::Port)?;
        Ok(Self {
            address: SocketAddr::from((ip, port)),
        })
    }

    /// Loads the listener configuration from the process environment.
    pub fn from_env() -> Result<Self, ConfigError> {
        let host = optional_environment("SIDECAR_HOST").map_err(|()| ConfigError::Host)?;
        let port = optional_environment("SIDECAR_PORT").map_err(|()| ConfigError::Port)?;
        Self::parse(host.as_deref(), port.as_deref())
    }

    /// Returns the validated private listener address.
    pub const fn address(self) -> SocketAddr {
        self.address
    }
}

fn optional_environment(name: &str) -> Result<Option<String>, ()> {
    match env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(env::VarError::NotUnicode(_)) => Err(()),
    }
}
