use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{OperationRegistry, RegistryError};
use crate::observation::Observer;

#[tokio::test]
async fn delivered_result_is_not_complete_until_its_task_is_joined() -> Result<(), RegistryError> {
    // Given: one operation whose work result can be received independently.
    let registry = OperationRegistry::new(Observer::production());
    let mut operation = registry
        .start(Uuid::new_v4(), |_cancelled| async { 41_u8 })
        .await?;

    // When: the worker delivers its result without the operation completion path.
    let result = (&mut operation.receiver)
        .await
        .map_err(|_| RegistryError::Internal)?;

    // Then: active work is already zero, but the specific task remains tracked until joined.
    assert_eq!(result, 41);
    assert_eq!(registry.active().await, 0);
    assert_eq!(registry.tracked().await, 1);
    registry.join_task(&operation.join_signal).await?;
    operation.completed = true;
    assert_eq!(registry.tracked().await, 0);
    Ok(())
}

#[tokio::test]
async fn wait_returns_only_after_its_specific_task_is_joined() -> Result<(), RegistryError> {
    // Given: one normally completing supervised operation.
    let registry = OperationRegistry::new(Observer::production());
    let operation = registry
        .start(Uuid::new_v4(), |_cancelled| async { 42_u8 })
        .await?;

    // When: the handler awaits the operation completion path.
    let result = operation.wait().await?;

    // Then: its value returns with no task left awaiting registry join.
    assert_eq!(result, 42);
    assert_eq!(registry.active().await, 0);
    assert_eq!(registry.tracked().await, 0);
    Ok(())
}

#[tokio::test]
async fn dropped_handler_is_joined_by_shutdown_after_cancellation() -> Result<(), RegistryError> {
    // Given: a supervised operation that exits only after request cancellation.
    let registry = OperationRegistry::new(Observer::production());
    let operation = registry
        .start(Uuid::new_v4(), |cancelled: CancellationToken| async move {
            cancelled.cancelled_owned().await;
        })
        .await?;
    assert_eq!(registry.tracked().await, 1);

    // When: the handler-owned operation is dropped and shutdown drains the registry.
    drop(operation);
    registry.shutdown(Uuid::new_v4()).await?;

    // Then: no supervised task remains merely completed-but-unjoined.
    assert_eq!(registry.active().await, 0);
    assert_eq!(registry.tracked().await, 0);
    Ok(())
}
