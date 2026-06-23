//! Claude IDE backend (orchestration plane, spec 2.1).
//!
//! Phase 0 wires the app shell: structured logging, managed `AppState`, the
//! Phase 0 command surface, and a clean app-exit teardown hook (no children to
//! reap yet, but the seam is in place for Phase 1+).

mod commands;
mod engine;
mod error;
mod perf;
mod preflight;
mod state;

use std::sync::Arc;
use std::time::Instant;

use engine::WorkspaceRegistry;
use state::AppState;
use tauri::Manager;

/// App entry. `startup` is captured by `main` as early as possible so the
/// cold-start budget measures real process-init time (spec 2.7).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(startup: Instant) {
    init_tracing();

    tauri::Builder::default()
        .manage(AppState::new(startup))
        .manage(Arc::new(WorkspaceRegistry::default()))
        .invoke_handler(tauri::generate_handler![
            commands::preflight,
            commands::report_ready,
            commands::perf_stats,
            commands::open_workspace,
            commands::engine_send,
            commands::engine_cancel,
            commands::close_workspace,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // Tear down every workspace's engine session so the app exits
                // with zero zombies (spec 2.5). Bounded by per-session timeout.
                let registry = app_handle.state::<Arc<WorkspaceRegistry>>();
                tauri::async_runtime::block_on(registry.shutdown_all());
                tracing::info!("exit requested; engine sessions torn down");
            }
        });
}

/// Structured logs to stderr. Honors `RUST_LOG`; defaults to `info`. Never logs
/// secrets or transcript contents (spec 2.6).
fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,claude_ide_lib=debug"));
    // `try_init` so a double-init (e.g. under test) is a no-op, not a panic.
    let _ = fmt().with_env_filter(filter).with_target(false).try_init();
}
