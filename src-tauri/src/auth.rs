//! Account: sign-in status + sign-out (Addendum II §S2.5).
//!
//! Never hand-rolled: both operations shell out to the installed `claude` CLI,
//! which owns the actual Anthropic account/session. `status` mirrors the
//! read-only probe `preflight.rs` already runs (`claude auth status`, here with
//! `--json` for the structured fields the Account UI shows). `logout` is a
//! plain non-interactive command.
//!
//! `login` is deliberately NOT modeled as a command here: signing in opens a
//! browser/OAuth flow (and can require SSO or an email-code step), so instead
//! of guessing at that interaction non-interactively, the frontend runs
//! `claude auth login` inside the IDE's existing PTY (`pty_open`) — the CLI's
//! own terminal UX just plays out for real. That keeps this module read-only
//! plus one narrow, non-interactive mutation, with no new arbitrary-exec path.

use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, IpcError, IpcErrorKind, IpcResult};

/// Mirror of `claude auth status --json`'s fields actually observed (2.1.197).
/// Every field but `logged_in` is optional — tolerant of a logged-out response
/// (or a future CLI) that omits some of them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub logged_in: bool,
    pub auth_method: Option<String>,
    pub api_provider: Option<String>,
    pub email: Option<String>,
    pub org_id: Option<String>,
    pub org_name: Option<String>,
    pub subscription_type: Option<String>,
}

/// `claude auth status --json`. Read-only; runs on a blocking thread so the
/// async runtime is never stalled (mirrors `preflight::run`).
pub async fn status() -> IpcResult<AuthStatus> {
    tauri::async_runtime::spawn_blocking(probe_status)
        .await
        .map_err(|e| IpcError::from(AppError::Io(std::io::Error::other(e.to_string()))))?
}

fn probe_status() -> IpcResult<AuthStatus> {
    let claude = crate::claude_bin::path()?;
    let out = Command::new(claude)
        .args(["auth", "status", "--json"])
        .output()
        .map_err(|e| internal(format!("Could not run `claude auth status`: {e}")))?;
    let text = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str::<AuthStatus>(&text)
        .map_err(|e| internal(format!("Could not read the auth status: {e}")))
}

/// `claude auth logout`. Non-interactive; reports failure only on a non-zero
/// exit (the CLI owns the actual credential wipe).
pub async fn logout() -> IpcResult<()> {
    tauri::async_runtime::spawn_blocking(do_logout)
        .await
        .map_err(|e| IpcError::from(AppError::Io(std::io::Error::other(e.to_string()))))?
}

fn do_logout() -> IpcResult<()> {
    let claude = crate::claude_bin::path()?;
    let out = Command::new(claude)
        .args(["auth", "logout"])
        .output()
        .map_err(|e| internal(format!("Could not run `claude auth logout`: {e}")))?;
    if out.status.success() {
        tracing::info!("signed out via `claude auth logout`");
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr);
        Err(internal(format!("Sign out failed: {}", stderr.trim())))
    }
}

fn internal(message: String) -> IpcError {
    IpcError::new(IpcErrorKind::Internal, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_logged_in_shape_observed_against_2_1_197() {
        let raw = r#"{
            "loggedIn": true,
            "authMethod": "claude.ai",
            "apiProvider": "firstParty",
            "email": "someone@example.com",
            "orgId": "abc-123",
            "orgName": "someone@example.com's Organization",
            "subscriptionType": "pro"
        }"#;
        let status: AuthStatus = serde_json::from_str(raw).unwrap();
        assert!(status.logged_in);
        assert_eq!(status.email.as_deref(), Some("someone@example.com"));
        assert_eq!(status.subscription_type.as_deref(), Some("pro"));
    }

    #[test]
    fn parses_a_minimal_logged_out_shape() {
        let raw = r#"{ "loggedIn": false }"#;
        let status: AuthStatus = serde_json::from_str(raw).unwrap();
        assert!(!status.logged_in);
        assert!(status.email.is_none());
    }
}
