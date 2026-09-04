use std::{
    collections::HashMap,
    future::Future,
    sync::Arc,
    time::{Duration, Instant},
};

use tokio::sync::{Mutex, Notify, Semaphore, oneshot};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    observation::{CounterDelta, ObservationEvent, Observer, Outcome, Stage},
    task_join::{JoinSignal, TaskSet},
};

const EXTRACTOR_PERMITS: usize = 4;

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub(crate) enum RegistryError {
    #[error("busy")]
    Busy,
    #[error("internal")]
    Internal,
}

#[derive(Debug)]
struct Control {
    accepting: bool,
    active: HashMap<Uuid, CancellationToken>,
}

#[derive(Debug)]
struct Inner {
    control: Mutex<Control>,
    permits: Arc<Semaphore>,
    tasks: Mutex<TaskSet>,
    changed: Notify,
    observer: Observer,
}

#[derive(Clone, Debug)]
pub(crate) struct OperationRegistry {
    inner: Arc<Inner>,
}

impl OperationRegistry {
    pub(crate) fn new(observer: Observer) -> Self {
        Self {
            inner: Arc::new(Inner {
                control: Mutex::new(Control {
                    accepting: true,
                    active: HashMap::with_capacity(EXTRACTOR_PERMITS),
                }),
                permits: Arc::new(Semaphore::new(EXTRACTOR_PERMITS)),
                tasks: Mutex::new(TaskSet::new(EXTRACTOR_PERMITS)),
                changed: Notify::new(),
                observer,
            }),
        }
    }

    pub(crate) async fn start<T, Work, WorkFuture>(
        &self,
        correlation_id: Uuid,
        work: Work,
    ) -> Result<Operation<T>, RegistryError>
    where
        T: Send + 'static,
        Work: FnOnce(CancellationToken) -> WorkFuture + Send + 'static,
        WorkFuture: Future<Output = T> + Send + 'static,
    {
        self.reap_completed().await?;
        let permit = Arc::clone(&self.inner.permits)
            .try_acquire_owned()
            .map_err(|_| RegistryError::Busy)?;
        let token = CancellationToken::new();
        let mut control = self.inner.control.lock().await;
        if !control.accepting || control.active.contains_key(&correlation_id) {
            return Err(RegistryError::Busy);
        }
        let mut tasks = self.inner.tasks.lock().await;
        control.active.insert(correlation_id, token.clone());
        self.inner.observer.emit(ObservationEvent::new(
            correlation_id,
            Stage::Registry,
            Outcome::Started,
            Duration::ZERO,
            CounterDelta::INCREMENT,
        ));
        let (sender, receiver) = oneshot::channel();
        let inner = Arc::clone(&self.inner);
        let task_token = token.clone();
        let join_signal = tasks.spawn(async move {
            let started = Instant::now();
            let result = work(task_token).await;
            {
                let mut control = inner.control.lock().await;
                control.active.remove(&correlation_id);
            }
            inner.observer.emit(ObservationEvent::new(
                correlation_id,
                Stage::Registry,
                Outcome::Success,
                started.elapsed(),
                CounterDelta::DECREMENT,
            ));
            inner.changed.notify_waiters();
            let _ignored = sender.send(result);
            drop(permit);
        });
        drop(tasks);
        drop(control);
        Ok(Operation {
            receiver,
            token,
            registry: self.clone(),
            join_signal,
            completed: false,
        })
    }

    async fn reap_completed(&self) -> Result<(), RegistryError> {
        let mut tasks = self.inner.tasks.lock().await;
        while let Some(result) = tasks.try_join_next() {
            result?;
        }
        Ok(())
    }

    async fn join_task(&self, signal: &JoinSignal) -> Result<(), RegistryError> {
        loop {
            if let Some(result) = signal.result() {
                return result;
            }
            let mut tasks = self.inner.tasks.lock().await;
            if let Some(result) = signal.result() {
                return result;
            }
            let joined = tasks.join_next().await.ok_or(RegistryError::Internal)?;
            drop(tasks);
            joined?;
        }
    }

    pub(crate) async fn stop_admission(&self) {
        let mut control = self.inner.control.lock().await;
        control.accepting = false;
        drop(control);
        self.inner.permits.close();
    }

    pub(crate) async fn shutdown(&self, correlation_id: Uuid) -> Result<(), RegistryError> {
        let started = Instant::now();
        self.inner.observer.emit(ObservationEvent::new(
            correlation_id,
            Stage::ShutdownDrain,
            Outcome::Started,
            Duration::ZERO,
            CounterDelta::INCREMENT,
        ));
        self.stop_admission().await;
        let tokens = {
            let control = self.inner.control.lock().await;
            control.active.values().cloned().collect::<Vec<_>>()
        };
        for token in tokens {
            token.cancel();
        }
        let mut tasks = self.inner.tasks.lock().await;
        let mut join_result = Ok(());
        while let Some(result) = tasks.join_next().await {
            if result.is_err() {
                join_result = Err(RegistryError::Internal);
            }
        }
        if !tasks.is_empty() {
            join_result = Err(RegistryError::Internal);
        }
        drop(tasks);
        if !self.inner.control.lock().await.active.is_empty() {
            return Err(RegistryError::Internal);
        }
        join_result?;
        self.inner.observer.emit(ObservationEvent::new(
            correlation_id,
            Stage::ShutdownDrain,
            Outcome::Success,
            started.elapsed(),
            CounterDelta::DECREMENT,
        ));
        Ok(())
    }

    #[cfg(any(test, feature = "test-upstream"))]
    pub(crate) async fn active(&self) -> usize {
        self.inner.control.lock().await.active.len()
    }

    #[cfg(test)]
    async fn tracked(&self) -> usize {
        self.inner.tasks.lock().await.len()
    }

    #[cfg(feature = "test-upstream")]
    pub(crate) async fn wait_for_active(&self, expected: usize) -> Result<(), RegistryError> {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let notified = self.inner.changed.notified();
                if self.active().await == expected {
                    return;
                }
                notified.await;
            }
        })
        .await
        .map_err(|_| RegistryError::Internal)
    }
}

#[derive(Debug)]
pub(crate) struct Operation<T> {
    receiver: oneshot::Receiver<T>,
    token: CancellationToken,
    registry: OperationRegistry,
    join_signal: Arc<JoinSignal>,
    completed: bool,
}

impl<T> Operation<T> {
    pub(crate) async fn wait(mut self) -> Result<T, RegistryError> {
        let result = (&mut self.receiver).await;
        let join_result = self.registry.join_task(&self.join_signal).await;
        self.completed = true;
        join_result?;
        result.map_err(|_| RegistryError::Internal)
    }
}

impl<T> Drop for Operation<T> {
    fn drop(&mut self) {
        if !self.completed {
            self.token.cancel();
        }
    }
}

#[cfg(test)]
mod tests;
