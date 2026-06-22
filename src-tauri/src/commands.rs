//! IPC command surface (frontend -> backend).
//!
//! Every command is `async`, returns `Result<T, IpcError>`, and validates its
//! inputs at the boundary (spec 2.4). Phase 0 exposes only environment preflight
//! and perf instrumentation; the workspace/engine/pty commands arrive with their
//! phases.

use tauri::State;

use crate::error::IpcResult;
use crate::perf::{self, PerfStats};
use crate::preflight::{self, PreflightReport};
use crate::state::AppState;

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
