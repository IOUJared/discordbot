//! End-to-end process tests for configuration, health, versioning, and shutdown.

use std::{
    env,
    io::{self, BufRead as _, BufReader, Read as _, Write as _},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, mpsc},
    thread,
    time::{Duration, Instant},
};

use discord_music_media_sidecar::config::Settings;
use nix::{
    sys::signal::{Signal, kill},
    unistd::Pid,
};
use serde_json::Value;

const TEN_SECONDS: Duration = Duration::from_secs(10);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const HEALTH_BODY: &str = r#"{"version":1,"status":"ok"}"#;

#[derive(Debug)]
struct RunningService {
    child: Option<Child>,
    logs: Arc<Mutex<String>>,
    log_reader: Option<thread::JoinHandle<()>>,
}

impl RunningService {
    fn spawn(port: &str) -> io::Result<(Self, mpsc::Receiver<String>)> {
        let mut child = Command::new(service_binary())
            .env("SIDECAR_HOST", "127.0.0.1")
            .env("SIDECAR_PORT", port)
            .env("SIDECAR_TEST_SECRET", "must-not-appear")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let logs = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("child logs were not piped"))?;
        let captured = Arc::new(Mutex::new(String::new()));
        let reader_capture = Arc::clone(&captured);
        let (sender, receiver) = mpsc::channel();
        let log_reader = thread::spawn(move || {
            for line in BufReader::new(logs).lines().map_while(Result::ok) {
                if let Ok(mut output) = reader_capture.lock() {
                    output.push_str(&line);
                    output.push('\n');
                }
                let _ignored = sender.send(line);
            }
        });
        Ok((
            Self {
                child: Some(child),
                logs: captured,
                log_reader: Some(log_reader),
            },
            receiver,
        ))
    }

    fn child_mut(&mut self) -> io::Result<&mut Child> {
        self.child
            .as_mut()
            .ok_or_else(|| io::Error::other("service process is unavailable"))
    }

    fn captured_logs(&self) -> io::Result<String> {
        self.logs
            .lock()
            .map(|output| output.clone())
            .map_err(|_| io::Error::other("log capture lock was poisoned"))
    }
}

impl Drop for RunningService {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ignored = child.kill();
            let _ignored = child.wait();
        }
        if let Some(reader) = self.log_reader.take() {
            let _ignored = reader.join();
        }
    }
}

fn service_binary() -> PathBuf {
    let release = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target/release/discord-music-media-sidecar");
    if release.is_file() {
        release
    } else {
        PathBuf::from(env!("CARGO_BIN_EXE_discord-music-media-sidecar"))
    }
}

fn deadline() -> io::Result<Instant> {
    Instant::now()
        .checked_add(TEN_SECONDS)
        .ok_or_else(|| io::Error::other("ten-second deadline overflowed"))
}

fn address_from_logs(receiver: &mpsc::Receiver<String>) -> io::Result<SocketAddr> {
    let deadline = deadline()?;
    while Instant::now() < deadline {
        let wait = deadline.saturating_duration_since(Instant::now());
        let line = match receiver.recv_timeout(wait.min(POLL_INTERVAL)) {
            Ok(line) => line,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "service stderr closed before reporting its listener",
                ));
            }
        };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(address) = value
            .get("fields")
            .and_then(|fields| fields.get("listen_address"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        return address
            .parse()
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error));
    }
    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        "service did not report a listener within ten seconds",
    ))
}

fn exact_health(address: SocketAddr) -> io::Result<()> {
    let mut stream = TcpStream::connect_timeout(&address, POLL_INTERVAL)?;
    stream.set_read_timeout(Some(POLL_INTERVAL))?;
    stream.write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    let (_, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| io::Error::other("health response had no header terminator"))?;
    assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
    assert_eq!(body, HEALTH_BODY);
    Ok(())
}

fn wait_for_exit(child: &mut Child) -> io::Result<()> {
    let deadline = deadline()?;
    while Instant::now() < deadline {
        if child.try_wait()?.is_some() {
            return Ok(());
        }
        thread::sleep(POLL_INTERVAL);
    }
    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        "service did not drain within ten seconds",
    ))
}

#[test]
fn config_defaults_and_rejects_invalid_values() -> Result<(), Box<dyn std::error::Error>> {
    // Given: no host or port overrides.
    // When: the settings boundary parses its inputs.
    let defaults = Settings::parse(None, None)?;

    // Then: loopback:3101 is selected and invalid boundaries are rejected.
    assert_eq!(defaults.address().to_string(), "127.0.0.1:3101");
    assert!(Settings::parse(Some("0.0.0.0"), Some("3101")).is_ok());
    assert!(Settings::parse(Some("example.com"), Some("3101")).is_err());
    assert!(Settings::parse(Some("127.0.0.1"), Some("70000")).is_err());
    Ok(())
}

#[test]
fn version_reports_pinned_rust_and_build_metadata() -> Result<(), Box<dyn std::error::Error>> {
    // Given: the compiled sidecar binary.
    // When: its version is requested.
    let output = Command::new(service_binary()).arg("--version").output()?;

    // Then: it reports the package, pinned compiler, and build revision without starting a listener.
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout)?;
    assert!(stdout.contains("discord-music-media-sidecar 0.1.0"));
    assert!(stdout.contains("rustc 1.98.0"));
    assert!(stdout.contains("build "));
    Ok(())
}

fn service_starts_and_drains(signal: Signal) -> Result<(), Box<dyn std::error::Error>> {
    let (mut service, receiver) = RunningService::spawn("0")?;
    let address = address_from_logs(&receiver).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "{error}; captured logs: {}",
                service.captured_logs().unwrap_or_default()
            ),
        )
    })?;

    exact_health(address)?;
    let raw_pid = i32::try_from(service.child_mut()?.id())?;
    kill(Pid::from_raw(raw_pid), signal)?;
    wait_for_exit(service.child_mut()?)?;

    assert!(TcpStream::connect_timeout(&address, POLL_INTERVAL).is_err());
    let logs = service.captured_logs()?;
    assert!(!logs.contains(HEALTH_BODY));
    assert!(!logs.contains("must-not-appear"));
    Ok(())
}

#[test]
fn health_release_starts_and_drains() -> Result<(), Box<dyn std::error::Error>> {
    // Given: the release service on an ephemeral loopback port with a teardown guard.
    // When: exact health is requested and the process receives SIGTERM.
    let result = service_starts_and_drains(Signal::SIGTERM);
    // Then: the response is exact and the process, listener, payload, and secret are absent.
    result
}

#[test]
fn interrupt_release_starts_and_drains() -> Result<(), Box<dyn std::error::Error>> {
    // Given: the release service on an ephemeral loopback port with a teardown guard.
    // When: exact health is requested and the process receives SIGINT.
    let result = service_starts_and_drains(Signal::SIGINT);
    // Then: the response is exact and the process, listener, payload, and secret are absent.
    result
}

#[test]
fn invalid_port_fails_before_bind_without_environment_dump()
-> Result<(), Box<dyn std::error::Error>> {
    // Given: an invalid port and a sentinel secret in the process environment.
    // When: the release service is invoked.
    let output = Command::new(service_binary())
        .env("SIDECAR_HOST", "127.0.0.1")
        .env("SIDECAR_PORT", "70000")
        .env("SIDECAR_TEST_SECRET", "must-not-appear")
        .output()?;

    // Then: it exits before binding and emits only the stable sanitized error.
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8(output.stderr)?,
        "media sidecar configuration error: SIDECAR_PORT must be an integer from 0 to 65535\n"
    );
    Ok(())
}
