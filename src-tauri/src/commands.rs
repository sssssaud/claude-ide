//! IPC command surface (frontend -> backend).
//!
//! Every command is `async`, returns `Result<T, IpcError>`, and validates its
//! inputs at the boundary (spec 2.4). Phase 0 exposes only environment preflight
//! and perf instrumentation; the workspace/engine/pty commands arrive with their
//! phases.

use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;

use crate::engine::{self, EngineEvent, EngineRegistry};
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

/// Send a turn into the engine; events stream back over `on_event`. Returns the
/// turn id (used to cancel). Phase 1 is mock-backed; the real `claude` session
/// is wired in step 4. Prompt text is treated strictly as data (spec 2.4).
#[tauri::command]
pub async fn engine_send(
    prompt: String,
    on_event: Channel<EngineEvent>,
    registry: State<'_, Arc<EngineRegistry>>,
) -> IpcResult<String> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err(IpcError::new(IpcErrorKind::InvalidInput, "Prompt is empty"));
    }
    if prompt.len() > MAX_PROMPT_LEN {
        return Err(IpcError::new(
            IpcErrorKind::InvalidInput,
            "Prompt exceeds the maximum length",
        ));
    }

    let (turn_id, cancel) = registry.begin_turn();
    let reg = registry.inner().clone();
    tauri::async_runtime::spawn(engine::run_mock_turn(
        reg,
        turn_id.clone(),
        cancel,
        prompt,
        on_event,
    ));
    Ok(turn_id)
}

/// Request cancellation of an in-flight turn (resolves to a clean `Stopped`).
#[tauri::command]
pub fn engine_cancel(turn_id: String, registry: State<'_, Arc<EngineRegistry>>) -> IpcResult<()> {
    registry.cancel(&turn_id);
    Ok(())
}
