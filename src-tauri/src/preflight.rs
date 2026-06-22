//! Preflight checks (spec 3.10).
//!
//! Before the IDE spawns or drives `claude`, it confirms the environment is
//! sane: the binary is on PATH, its version is readable, and the user is
//! authenticated. Every fact here is probed from the *installed* CLI — never
//! assumed (spec 1.5, 3.10). On failure the frontend shows a guided fix; it
//! does not attempt to spawn.
//!
//! All `claude` invocations are read-only status queries. They run on a
//! blocking thread (`spawn_blocking`) so the async runtime is never stalled.

use std::process::Command;

use serde::Serialize;

use crate::error::{AppError, IpcError, IpcResult};

/// Result of the environment preflight, mirrored 1:1 in `src/ipc/types.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightReport {
    /// `claude` resolved on PATH.
    pub claude_found: bool,
    /// Absolute path to the resolved binary, if found.
    pub claude_path: Option<String>,
    /// First line of `claude --version`, if it ran.
    pub version: Option<String>,
    /// `claude auth status` exited 0.
    pub authenticated: bool,
    /// A short, non-secret status line for the UI (e.g. login method/account).
    pub auth_detail: Option<String>,
    /// Overall gate: found AND authenticated.
    pub ok: bool,
}

/// Locate `claude` and probe version + auth. Never errors on a *failed* check —
/// a missing or unauthed CLI is a valid, reported state, not an `IpcError`.
/// `IpcError` is reserved for the probe itself going wrong unexpectedly.
pub async fn run() -> IpcResult<PreflightReport> {
    let report = tauri::async_runtime::spawn_blocking(probe)
        .await
        .map_err(|e| IpcError::from(AppError::Io(std::io::Error::other(e.to_string()))))?;
    Ok(report)
}

fn probe() -> PreflightReport {
    let claude_path = which::which("claude").ok();
    let claude_found = claude_path.is_some();

    if !claude_found {
        tracing::warn!("preflight: `claude` not found on PATH");
        return PreflightReport {
            claude_found: false,
            claude_path: None,
            version: None,
            authenticated: false,
            auth_detail: None,
            ok: false,
        };
    }

    let version = run_capture(&["--version"]).and_then(|out| {
        out.stdout
            .lines()
            .next()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
    });

    // `claude auth status` exits 0 when logged in (verified against 2.1.185).
    let auth = run_capture(&["auth", "status"]);
    let authenticated = auth.as_ref().map(|o| o.success).unwrap_or(false);
    let auth_detail = auth.and_then(|o| {
        let text = if o.success { o.stdout } else { o.stderr };
        text.lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .map(|l| l.to_string())
    });

    let path_str = claude_path.as_ref().map(|p| p.display().to_string());
    tracing::info!(
        version = version.as_deref().unwrap_or("?"),
        authenticated,
        "preflight complete"
    );

    PreflightReport {
        claude_found: true,
        claude_path: path_str,
        version,
        authenticated,
        ok: authenticated,
        auth_detail,
    }
}

struct Captured {
    success: bool,
    stdout: String,
    stderr: String,
}

/// Run `claude <args>` and capture output. Returns `None` if the process could
/// not be spawned at all (already covered by the PATH check, but defensive).
fn run_capture(args: &[&str]) -> Option<Captured> {
    match Command::new("claude").args(args).output() {
        Ok(out) => Some(Captured {
            success: out.status.success(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        }),
        Err(e) => {
            tracing::warn!(args = ?args, error = %e, "failed to run claude");
            None
        }
    }
}
