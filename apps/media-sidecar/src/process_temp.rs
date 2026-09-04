use std::{
    fs,
    os::unix::fs::PermissionsExt as _,
    path::{Path, PathBuf},
};

use uuid::Uuid;

use super::ProcessError;

#[derive(Debug)]
pub(super) struct OwnedTemporaryDirectory {
    path: Option<PathBuf>,
}

impl OwnedTemporaryDirectory {
    pub(super) fn create(parent: &Path) -> Result<Self, ProcessError> {
        fs::create_dir_all(parent).map_err(|_| ProcessError::Spawn)?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|_| ProcessError::Spawn)?;
        let path = parent.join(Uuid::new_v4().simple().to_string());
        fs::create_dir(&path).map_err(|_| ProcessError::Spawn)?;
        let directory = Self { path: Some(path) };
        fs::set_permissions(directory.path()?, fs::Permissions::from_mode(0o700))
            .map_err(|_| ProcessError::Spawn)?;
        Ok(directory)
    }

    pub(super) fn path(&self) -> Result<&Path, ProcessError> {
        self.path.as_deref().ok_or(ProcessError::SupervisorClosed)
    }

    pub(super) fn remove(mut self) -> Result<(), ProcessError> {
        let path = self.path.take().ok_or(ProcessError::SupervisorClosed)?;
        match fs::remove_dir_all(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(ProcessError::Failed),
        }
    }
}

impl Drop for OwnedTemporaryDirectory {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            let _ignored = fs::remove_dir_all(path);
        }
    }
}
