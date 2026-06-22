//! Error layering for the backend (spec 2.6).
//!
//! Internal failures are typed with `thiserror` (`AppError`); at the IPC
//! boundary they convert to a serializable `IpcError { kind, message, detail? }`.
//! Commands return `Result<T, IpcError>` so a failure surfaces as a structured
//! value in the webview — never a panic crossing IPC, never a raw stack trace.
//!
//! The taxonomy is intentionally minimal for Phase 0 (only what is actually
//! constructed). It grows per phase as new failure modes are wired — e.g. path
//! validation and process-spawn errors arrive with `open_workspace` in Phase 1.

use serde::Serialize;

/// Typed internal error. Stays inside Rust.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Stable, machine-readable error categories the frontend can branch on.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IpcErrorKind {
    Internal,
    InvalidInput,
}

/// The serializable error that crosses the IPC boundary.
#[derive(Debug, Clone, Serialize)]
pub struct IpcError {
    pub kind: IpcErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl IpcError {
    pub fn new(kind: IpcErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), detail: None }
    }
}

impl From<AppError> for IpcError {
    fn from(err: AppError) -> Self {
        match err {
            // Display impls are plain-language and safe to surface.
            AppError::Io(_) => IpcError::new(IpcErrorKind::Internal, err.to_string()),
        }
    }
}

pub type IpcResult<T> = Result<T, IpcError>;
