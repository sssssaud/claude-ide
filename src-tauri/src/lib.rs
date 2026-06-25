//! Claude IDE backend (orchestration plane, spec 2.1).
//!
//! Phase 0 wires the app shell: structured logging, managed `AppState`, the
//! Phase 0 command surface, and a clean app-exit teardown hook (no children to
//! reap yet, but the seam is in place for Phase 1+).

mod commands;
mod engine;
mod error;
mod files;
mod git;
mod perf;
mod preflight;
mod pty;
mod search;
mod sessions;
mod state;
mod workspace;

use std::sync::Arc;
use std::time::Instant;

use engine::WorkspaceRegistry;
use pty::PtyRegistry;
use sessions::SessionsRegistry;
use state::AppState;
use tauri::Manager;

/// App entry. `startup` is captured by `main` as early as possible so the
/// cold-start budget measures real process-init time (spec 2.7).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(startup: Instant) {
    init_tracing();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new(startup))
        .manage(Arc::new(WorkspaceRegistry::default()))
        .manage(Arc::new(PtyRegistry::default()))
        .manage(Arc::new(SessionsRegistry::default()))
        .invoke_handler(tauri::generate_handler![
            commands::preflight,
            commands::report_ready,
            commands::perf_stats,
            commands::open_workspace,
            commands::engine_send,
            commands::engine_cancel,
            commands::resume_workspace,
            commands::read_session,
            commands::close_workspace,
            commands::pty_open,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_close,
            commands::list_sessions,
            commands::watch_sessions,
            commands::list_dir,
            commands::read_file,
            commands::write_file,
            commands::git_status,
            commands::git_diff,
            commands::git_stage,
            commands::git_unstage,
            commands::git_stage_all,
            commands::git_unstage_all,
            commands::git_commit,
            commands::git_branches,
            commands::git_switch_branch,
            commands::git_create_branch,
            commands::git_discard,
            commands::search,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // Tear down every workspace's engine session + terminal so the
                // app exits with zero zombies (spec 2.5, 5.A.6).
                let engines = app_handle.state::<Arc<WorkspaceRegistry>>();
                tauri::async_runtime::block_on(engines.shutdown_all());
                app_handle.state::<Arc<PtyRegistry>>().shutdown_all();
                app_handle.state::<Arc<SessionsRegistry>>().shutdown_all();
                tracing::info!("exit requested; engine sessions + terminals + watchers torn down");
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
