//! IPC command surface (frontend -> backend).
//!
//! Every command is `async`, returns `Result<T, IpcError>`, and validates its
//! inputs at the boundary (spec 2.4). Phase 0 exposes environment preflight and
//! perf; Phase 1 adds the workspace engine session — open a persistent `claude`
//! session, write turns, interrupt, and close it cleanly. The PTY commands
//! arrive with their phases.

use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;

use crate::engine::{EngineEvent, WorkspaceRegistry};
use crate::error::{IpcError, IpcErrorKind, IpcResult};
use crate::files::{DirEntry, FileContents};
use crate::perf::{self, PerfStats};
use crate::preflight::{self, PreflightReport};
use crate::pty::PtyRegistry;
use crate::sessions::{SessionMeta, SessionsRegistry};
use crate::state::AppState;

/// Upper bound on a single prompt (defensive; treats prompt strictly as data).
const MAX_PROMPT_LEN: usize = 100_000;

/// Probe the installed `claude` CLI: presence, version, auth (spec 3.10).
#[tauri::command]
pub async fn preflight() -> IpcResult<PreflightReport> {
    preflight::run().await
}

/// Called once by the frontend on first paint to anchor the cold-start budget.
/// Returns the recorded cold-start time in milliseconds.
#[tauri::command]
pub fn report_ready(state: State<'_, AppState>) -> IpcResult<u64> {
    let ms = state.record_cold_start();
    tracing::info!(cold_start_ms = ms, "ui reported ready");
    perf::mark_cold_start(ms);
    Ok(ms)
}

/// Current perf snapshot (cold start + RSS) for the dev-only perf readout.
#[tauri::command]
pub fn perf_stats(state: State<'_, AppState>) -> IpcResult<PerfStats> {
    Ok(perf::stats(state.cold_start_ms()))
}

/// Open a persistent `claude` engine session. Every event for the session
/// streams back over `on_event`; returns the workspace id used by the other
/// engine commands. `cwd` defaults to the launch directory (picker is Phase 4).
#[tauri::command]
pub async fn open_workspace(
    cwd: Option<String>,
    on_event: Channel<EngineEvent>,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> IpcResult<String> {
    registry.open(cwd, on_event).await
}

/// Send one turn into a workspace session. Prompt text is treated strictly as
/// data (spec 2.4); responses arrive over the session's `on_event` channel.
#[tauri::command]
pub async fn engine_send(
    workspace_id: String,
    prompt: String,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> IpcResult<()> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(IpcError::new(IpcErrorKind::InvalidInput, "Prompt is empty"));
    }
    if prompt.len() > MAX_PROMPT_LEN {
        return Err(IpcError::new(
            IpcErrorKind::InvalidInput,
            "Prompt exceeds the maximum length",
        ));
    }
    registry.send(&workspace_id, prompt).await
}

/// Interrupt the in-flight turn in a workspace (resolves to a clean `Stopped`;
/// the session itself survives).
#[tauri::command]
pub async fn engine_cancel(
    workspace_id: String,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> IpcResult<()> {
    registry.cancel(&workspace_id).await
}

/// Close a workspace session, reaping the child with no zombie (spec 2.5).
#[tauri::command]
pub async fn close_workspace(
    workspace_id: String,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> IpcResult<()> {
    registry.close(&workspace_id).await
}

// ----- Terminal drawer PTY (spec 5.A.6) --------------------------------------
// Sync commands: each does a quick, non-blocking PTY syscall (the blocking
// reads run on a dedicated thread in `pty.rs`). Raw output streams over the
// `on_data` channel.

/// Open a plain shell in a PTY sized `rows`x`cols`; output streams over `on_data`.
#[tauri::command]
pub fn pty_open(
    rows: u16,
    cols: u16,
    on_data: Channel<Vec<u8>>,
    registry: State<'_, Arc<PtyRegistry>>,
) -> IpcResult<String> {
    registry.inner().clone().open(rows, cols, on_data)
}

/// Write keystrokes into a terminal (treated strictly as bytes for the shell).
#[tauri::command]
pub fn pty_write(
    pty_id: String,
    data: String,
    registry: State<'_, Arc<PtyRegistry>>,
) -> IpcResult<()> {
    registry.write(&pty_id, data.as_bytes())
}

/// Resize a terminal's PTY to match the drawer.
#[tauri::command]
pub fn pty_resize(
    pty_id: String,
    rows: u16,
    cols: u16,
    registry: State<'_, Arc<PtyRegistry>>,
) -> IpcResult<()> {
    registry.resize(&pty_id, rows, cols)
}

/// Close a terminal, reaping its shell with no zombie (spec 5.A.6).
#[tauri::command]
pub fn pty_close(pty_id: String, registry: State<'_, Arc<PtyRegistry>>) -> IpcResult<()> {
    registry.close(&pty_id)
}

// ----- Sessions rail (spec 3.2, 3.3) -----------------------------------------

/// List the workspace's `claude` sessions (read-only), newest activity first.
/// Populates the rail **on open** with no forced turn (spec 3.2).
#[tauri::command]
pub fn list_sessions(cwd: Option<String>) -> IpcResult<Vec<SessionMeta>> {
    crate::sessions::list(cwd)
}

/// Watch `~/.claude/projects/` so a newly-created session appears in the rail
/// live (spec 3.2). The refreshed list streams over `on_change`.
#[tauri::command]
pub fn watch_sessions(
    cwd: Option<String>,
    on_change: Channel<Vec<SessionMeta>>,
    registry: State<'_, Arc<SessionsRegistry>>,
) -> IpcResult<()> {
    registry.watch(cwd, on_change)
}

// ----- Editor file surface (spec 5.A.3, Phase 4) -----------------------------
// Both confined to the workspace root in `files.rs`.

/// List a workspace directory for the file explorer (dirs first, lazy).
#[tauri::command]
pub fn list_dir(path: Option<String>) -> IpcResult<Vec<DirEntry>> {
    crate::files::list_dir(path)
}

/// Read a workspace file for the editor (UTF-8 text, size-capped, binary-guarded).
#[tauri::command]
pub fn read_file(path: String) -> IpcResult<FileContents> {
    crate::files::read_file(path)
}
