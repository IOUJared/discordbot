use std::{
    ffi::OsString,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    process::{ExitStatus, Stdio},
    task::{Context, Poll},
    time::Duration,
};

use nix::{
    sys::signal::{Signal, killpg},
    unistd::Pid,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt as _},
    process::Command,
    sync::{mpsc, oneshot},
};
use tokio_util::sync::CancellationToken;

const STDOUT_LIMIT: usize = 4 * 1024 * 1024;
const STDERR_LIMIT: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub(crate) enum ProcessError {
    #[error("spawn_failed")]
    Spawn,
    #[error("process_failed")]
    Failed,
    #[error("deadline_exceeded")]
    Deadline,
    #[error("cancelled")]
    Cancelled,
    #[error("output_limit")]
    OutputLimit,
    #[error("process_supervisor_closed")]
    SupervisorClosed,
}

#[derive(Debug)]
pub(crate) struct ProcessOutput {
    pub(crate) stdout: Vec<u8>,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ProcessSpec<'a> {
    pub(crate) executable: &'a Path,
    pub(crate) arguments: &'a [OsString],
    pub(crate) deadline: Duration,
}

#[derive(Debug)]
pub(crate) struct ProcessExecution {
    result: oneshot::Receiver<Result<ProcessOutput, ProcessError>>,
    dropped: CancellationToken,
    completed: bool,
}

impl Future for ProcessExecution {
    type Output = Result<ProcessOutput, ProcessError>;

    fn poll(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        match Pin::new(&mut self.result).poll(context) {
            Poll::Ready(Ok(result)) => {
                self.completed = true;
                Poll::Ready(result)
            }
            Poll::Ready(Err(_)) => {
                self.completed = true;
                Poll::Ready(Err(ProcessError::SupervisorClosed))
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for ProcessExecution {
    fn drop(&mut self) {
        if !self.completed {
            self.dropped.cancel();
        }
    }
}

pub(crate) fn execute(spec: ProcessSpec<'_>, cancelled: CancellationToken) -> ProcessExecution {
    let (result_sender, result) = oneshot::channel();
    let dropped = CancellationToken::new();
    tokio::spawn(supervise(
        spec.executable.to_path_buf(),
        spec.arguments.to_vec(),
        spec.deadline,
        cancelled,
        dropped.clone(),
        result_sender,
    ));
    ProcessExecution {
        result,
        dropped,
        completed: false,
    }
}

#[derive(Debug)]
enum Event {
    Stdout(Result<Vec<u8>, ProcessError>),
    Stderr(Result<Vec<u8>, ProcessError>),
    Exited(Result<ExitStatus, ProcessError>),
}

async fn supervise(
    executable: PathBuf,
    arguments: Vec<OsString>,
    deadline: Duration,
    cancelled: CancellationToken,
    dropped: CancellationToken,
    result_sender: oneshot::Sender<Result<ProcessOutput, ProcessError>>,
) {
    let result = supervise_inner(&executable, &arguments, deadline, cancelled, dropped).await;
    let _ignored = result_sender.send(result);
}

async fn supervise_inner(
    executable: &Path,
    arguments: &[OsString],
    deadline: Duration,
    cancelled: CancellationToken,
    dropped: CancellationToken,
) -> Result<ProcessOutput, ProcessError> {
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("LANG", "C.UTF-8")
        .env("LC_ALL", "C.UTF-8")
        .env("HOME", "/nonexistent")
        .env("TMPDIR", "/tmp")
        .env("SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child = command.spawn().map_err(|_| ProcessError::Spawn)?;
    let process_group = child
        .id()
        .and_then(|id| i32::try_from(id).ok())
        .ok_or(ProcessError::Spawn)?;
    let stdout = child.stdout.take().ok_or(ProcessError::Spawn)?;
    let stderr = child.stderr.take().ok_or(ProcessError::Spawn)?;
    let (sender, mut events) = mpsc::channel(3);
    spawn_reader(sender.clone(), stdout, STDOUT_LIMIT, true);
    spawn_reader(sender.clone(), stderr, STDERR_LIMIT, false);
    tokio::spawn(async move {
        let event = child.wait().await.map_err(|_| ProcessError::Failed);
        let _ignored = sender.send(Event::Exited(event)).await;
    });

    let timeout = tokio::time::sleep(deadline);
    tokio::pin!(timeout);
    let mut outcome = None;
    let mut stdout = None;
    let mut stdout_done = false;
    let mut stderr_done = false;
    let mut exit_status = None;
    while !stdout_done || !stderr_done || exit_status.is_none() {
        tokio::select! {
            biased;
            () = cancelled.cancelled(), if outcome.is_none() => {
                outcome = Some(ProcessError::Cancelled);
                kill_group(process_group)?;
            }
            () = dropped.cancelled(), if outcome.is_none() => {
                outcome = Some(ProcessError::Cancelled);
                kill_group(process_group)?;
            }
            () = &mut timeout, if outcome.is_none() => {
                outcome = Some(ProcessError::Deadline);
                kill_group(process_group)?;
            }
            event = events.recv() => match event.ok_or(ProcessError::SupervisorClosed)? {
                Event::Stdout(result) => match result {
                    Ok(bytes) => { stdout = Some(bytes); stdout_done = true; },
                    Err(error) => {
                        stdout_done = true;
                        if outcome.is_none() { outcome = Some(error); kill_group(process_group)?; }
                    }
                },
                Event::Stderr(result) => match result {
                    Ok(_) => stderr_done = true,
                    Err(error) => {
                        stderr_done = true;
                        if outcome.is_none() { outcome = Some(error); kill_group(process_group)?; }
                    }
                },
                Event::Exited(result) => exit_status = Some(result?),
            },
        }
    }
    if let Some(error) = outcome {
        return Err(error);
    }
    if !exit_status.is_some_and(|status| status.success()) {
        return Err(ProcessError::Failed);
    }
    stdout
        .map(|stdout| ProcessOutput { stdout })
        .ok_or(ProcessError::SupervisorClosed)
}

fn spawn_reader<R>(sender: mpsc::Sender<Event>, reader: R, limit: usize, is_stdout: bool)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let result = read_bounded(reader, limit).await;
        let event = if is_stdout {
            Event::Stdout(result)
        } else {
            Event::Stderr(result)
        };
        let _ignored = sender.send(event).await;
    });
}

async fn read_bounded<R>(mut reader: R, limit: usize) -> Result<Vec<u8>, ProcessError>
where
    R: AsyncRead + Unpin,
{
    let mut output = Vec::with_capacity(limit.min(8192));
    let mut chunk = [0_u8; 8192];
    loop {
        let count = reader
            .read(&mut chunk)
            .await
            .map_err(|_| ProcessError::Failed)?;
        if count == 0 {
            return Ok(output);
        }
        if output.len().saturating_add(count) > limit {
            return Err(ProcessError::OutputLimit);
        }
        output.extend_from_slice(chunk.get(..count).ok_or(ProcessError::Failed)?);
    }
}

fn kill_group(process_group: i32) -> Result<(), ProcessError> {
    match killpg(Pid::from_raw(process_group), Signal::SIGKILL) {
        Ok(()) | Err(nix::errno::Errno::ESRCH) => Ok(()),
        Err(_) => Err(ProcessError::Failed),
    }
}
