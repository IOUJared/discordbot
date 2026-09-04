use std::{
    collections::HashMap,
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
};

use tokio::task::{Id, JoinError, JoinSet};

use crate::operations::RegistryError;

const JOIN_PENDING: u8 = 0;
const JOIN_SUCCESS: u8 = 1;
const JOIN_FAILURE: u8 = 2;

#[derive(Debug)]
pub(crate) struct JoinSignal(AtomicU8);

impl JoinSignal {
    const fn pending() -> Self {
        Self(AtomicU8::new(JOIN_PENDING))
    }

    fn complete(&self, result: Result<(), RegistryError>) {
        self.0.store(
            if result.is_ok() {
                JOIN_SUCCESS
            } else {
                JOIN_FAILURE
            },
            Ordering::Release,
        );
    }

    pub(crate) fn result(&self) -> Option<Result<(), RegistryError>> {
        match self.0.load(Ordering::Acquire) {
            JOIN_PENDING => None,
            JOIN_SUCCESS => Some(Ok(())),
            _ => Some(Err(RegistryError::Internal)),
        }
    }
}

#[derive(Debug)]
pub(crate) struct TaskSet {
    tasks: JoinSet<()>,
    signals: HashMap<Id, Arc<JoinSignal>>,
}

impl TaskSet {
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            tasks: JoinSet::new(),
            signals: HashMap::with_capacity(capacity),
        }
    }

    pub(crate) fn spawn<F>(&mut self, future: F) -> Arc<JoinSignal>
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let signal = Arc::new(JoinSignal::pending());
        let task = self.tasks.spawn(future);
        self.signals.insert(task.id(), Arc::clone(&signal));
        signal
    }

    pub(crate) fn try_join_next(&mut self) -> Option<Result<(), RegistryError>> {
        self.tasks
            .try_join_next_with_id()
            .map(|joined| self.record(joined))
    }

    pub(crate) async fn join_next(&mut self) -> Option<Result<(), RegistryError>> {
        self.tasks
            .join_next_with_id()
            .await
            .map(|joined| self.record(joined))
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.signals.is_empty()
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.signals.len()
    }

    fn record(&mut self, joined: Result<(Id, ()), JoinError>) -> Result<(), RegistryError> {
        let (id, result) = match joined {
            Ok((id, ())) => (id, Ok(())),
            Err(error) => (error.id(), Err(RegistryError::Internal)),
        };
        let signal = self.signals.remove(&id).ok_or(RegistryError::Internal)?;
        signal.complete(result);
        result
    }
}
