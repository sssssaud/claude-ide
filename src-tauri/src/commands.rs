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
use crate::perf::{self, PerfStats};
use crate::preflight::{self, PreflightReport};
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
