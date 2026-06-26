//! Agents / parallel-sessions dashboard + daemon status (Phase 9). Read-only.
//!
//! As a wrapper we never manage agents ourselves — the CLI owns that. We surface
//! its own authoritative view: `claude agents --json` lists every live `claude`
//! session (interactive + background) with pid / cwd / kind / status (verified
//! against CLI 2.1.193). `--all` includes completed ones. We also read the
//! transient daemon's `~/.claude/daemon/roster.json` and check whether its
//! supervisor pid is actually alive — the daemon spawns on demand and self-exits
//! when idle, so "not running" is the normal, honest state.

use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

use crate::error::{AppError, IpcError, IpcErrorKind, IpcResult};

/// One live (or completed) `claude` session, as reported by `claude agents
/// --json`. Every field is optional so a CLI schema drift can't break the view;
/// unknown fields are ignored. Re-serialized camelCase for the frontend.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentSession {
    pub pid: Option<u32>,
    pub cwd: Option<String>,
    /// "interactive" | "background" | … (whatever the CLI reports).
    pub kind: Option<String>,
    pub session_id: Option<String>,
    /// Epoch ms.
    pub started_at: Option<u64>,
    /// "busy" | "idle" | … (the CLI's own status).
    pub status: Option<String>,
}

/// Transient-daemon status, derived from `roster.json` + a pid liveness check.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatus {
    /// The supervisor pid in the roster is actually alive right now.
    pub running: bool,
    pub supervisor_pid: Option<u32>,
    /// Active workers recorded in the roster.
    pub worker_count: u32,
    /// Roster last-updated epoch ms (if present).
    pub updated_at: Option<u64>,
}

/// List live `claude` sessions via the CLI's own `agents --json` (read-only).
/// `include_completed` adds `--all`. Runs on a blocking thread (it spawns a
/// short-lived process).
pub async fn list(include_completed: bool) -> IpcResult<Vec<AgentSession>> {
    tauri::async_runtime::spawn_blocking(move || list_blocking(include_completed))
        .await
        .map_err(|e| IpcError::from(AppError::Io(std::io::Error::other(e.to_string()))))?
}

fn list_blocking(include_completed: bool) -> IpcResult<Vec<AgentSession>> {
    let mut args = vec!["agents", "--json"];
    if include_completed {
        args.push("--all");
    }
    let out = Command::new("claude").args(&args).output().map_err(|e| {
        IpcError::new(IpcErrorKind::Internal, format!("Could not run `claude agents`: {e}"))
    })?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let line = stderr.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("`claude agents` failed");
        return Err(IpcError::new(IpcErrorKind::Internal, line.to_string()));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    Ok(parse_sessions(&stdout))
}

/// Parse the `claude agents --json` array. Tolerant: a non-array or junk payload
/// yields an empty list rather than an error (the command already succeeded).
fn parse_sessions(stdout: &str) -> Vec<AgentSession> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    match serde_json::from_str::<Vec<AgentSession>>(trimmed) {
        Ok(list) => list,
        Err(_) => {
            // Be lenient on element shape: keep the ones that parse individually.
            match serde_json::from_str::<Vec<Value>>(trimmed) {
                Ok(values) => values
                    .into_iter()
                    .filter_map(|v| serde_json::from_value(v).ok())
                    .collect(),
                Err(_) => Vec::new(),
            }
        }
    }
}

/// Read the daemon roster and report whether the supervisor is actually alive.
pub fn daemon_status() -> IpcResult<DaemonStatus> {
    let path = match crate::sessions::home_dir() {
        Some(h) => h.join(".claude").join("daemon").join("roster.json"),
        None => return Ok(idle_status()),
    };
    if !path.is_file() {
        return Ok(idle_status());
    }
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return Ok(idle_status()),
    };
    let v: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return Ok(idle_status()),
    };
    let supervisor_pid = v.get("supervisorPid").and_then(Value::as_u64).map(|p| p as u32);
    let updated_at = v.get("updatedAt").and_then(Value::as_u64);
    let worker_count = v
        .get("workers")
        .and_then(Value::as_object)
        .map(|w| w.len() as u32)
        .unwrap_or(0);
    let running = supervisor_pid.map(pid_alive).unwrap_or(false);
    Ok(DaemonStatus { running, supervisor_pid, worker_count, updated_at })
}

fn idle_status() -> DaemonStatus {
    DaemonStatus { running: false, supervisor_pid: None, worker_count: 0, updated_at: None }
}

/// Is `pid` a live process? Refreshes only that pid, so the check is cheap and
/// portable (via sysinfo, already a dependency).
fn pid_alive(pid: u32) -> bool {
    let pid = Pid::from_u32(pid);
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing(),
    );
    sys.process(pid).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_agents_json_array() {
        let json = r#"[
            {"pid":3848,"cwd":"/home/saud/p","kind":"interactive","startedAt":1782454587346,"sessionId":"abc","status":"busy"},
            {"pid":99,"kind":"background","status":"idle"}
        ]"#;
        let list = parse_sessions(json);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].pid, Some(3848));
        assert_eq!(list[0].kind.as_deref(), Some("interactive"));
        assert_eq!(list[0].session_id.as_deref(), Some("abc"));
        assert_eq!(list[0].status.as_deref(), Some("busy"));
        // missing fields are tolerated (None), not errors
        assert_eq!(list[1].cwd, None);
        assert_eq!(list[1].started_at, None);
    }

    #[test]
    fn tolerates_empty_and_junk() {
        assert!(parse_sessions("").is_empty());
        assert!(parse_sessions("[]").is_empty());
        assert!(parse_sessions("not json").is_empty());
        assert!(parse_sessions("{\"not\":\"an array\"}").is_empty());
    }

    #[test]
    fn dead_pid_is_not_alive() {
        // pid 0 is never a normal user process; the check must not panic and
        // must report not-alive.
        assert!(!pid_alive(0));
    }
}
