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
///
/// ERROR-DETAIL POLICY (hardening C4 — reviewed and deliberately kept):
/// `message` stays plain-language and helpful rather than genericized. This is a
/// LOCAL, single-user desktop app — the webview is the same trust domain as the
/// backend, so there is no remote client to leak to; the reader of any error is
/// the user, about their own machine. Audited: every interpolated message embeds
/// only a `std::io::Error`/tool Display string (e.g. "Permission denied") — which
/// Rust does NOT pepper with paths — never a path, query, session id, or secret.
/// Stripping that detail ("Permission denied" -> a vague "Could not read") would
/// cost self-diagnosis for no security gain. Detail is additionally tracing-logged
/// in the process modules (preflight/agents/pty/engine/sessions). The `detail`
/// field exists for a future structured split if a genuinely sensitive value ever
/// needs surfacing separately; today nothing populates it. Secrets/transcripts are
/// never logged or surfaced (spec 2.6) — that rule is upstream of this type.
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
