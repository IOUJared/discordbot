use tokio::{
    io::{AsyncRead, AsyncReadExt as _},
    process::ChildStderr,
    sync::mpsc,
};

use super::ProcessError;

const STDOUT_LIMIT: usize = 4 * 1024 * 1024;
const STDERR_LIMIT: usize = 64 * 1024;

#[derive(Debug)]
pub(super) enum Event {
    Stdout(Result<Vec<u8>, ProcessError>),
    Stderr(Result<Vec<u8>, ProcessError>),
    Exited(Result<std::process::ExitStatus, ProcessError>),
}

pub(super) fn read_stdout(sender: mpsc::Sender<Event>, stdout: tokio::process::ChildStdout) {
    spawn_reader(sender, stdout, STDOUT_LIMIT, true);
}

pub(super) fn read_stderr(sender: mpsc::Sender<Event>, stderr: ChildStderr) {
    spawn_reader(sender, stderr, STDERR_LIMIT, false);
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
