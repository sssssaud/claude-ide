//! Claude IDE backend (orchestration plane, spec 2.1).
//!
//! Phase 0 wires the app shell: structured logging, managed `AppState`, the
//! Phase 0 command surface, and a clean app-exit teardown hook (no children to
//! reap yet, but the seam is in place for Phase 1+).

mod commands;
mod error;
mod perf;
mod preflight;
mod state;

use std::time::Instant;

use state::AppState;

/// App entry. `startup` is captured by `main` as early as possible so the
/// cold-start budget measures real process-init time (spec 2.7).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(startup: Instant) {
    init_tracing();

    tauri::Builder::default()
        .manage(AppState::new(startup))
        .invoke_handler(tauri::generate_handler![
            commands::preflight,
            commands::report_ready,
            commands::perf_stats,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // Teardown seam: Phase 1+ tears down every workspace's engine
                // session + PTY here so the app exits with zero zombies
                // (spec 2.5). Nothing to reap in Phase 0.
                tracing::info!("exit requested; teardown complete");
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
