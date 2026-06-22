//! Backend managed state.
//!
//! Phase 0 holds only what the cold-start budget needs: the instant the app
//! process began initializing. The authoritative `WorkspaceRegistry` (spec 2.5)
//! — process handles, per-workspace engine sessions, the state machine — is
//! introduced in Phase 1, when there is real state to own.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

/// Process-global state managed by Tauri (`app.manage(AppState::new())`).
pub struct AppState {
    /// Captured as early as possible in `run()` to anchor the cold-start metric.
    startup: Instant,
    /// Milliseconds from `startup` to the first frontend "ready" signal.
    /// `0` means not yet reported. Written once by `report_ready`.
    cold_start_ms: AtomicU64,
}

impl AppState {
    pub fn new(startup: Instant) -> Self {
        Self { startup, cold_start_ms: AtomicU64::new(0) }
    }

    /// Elapsed milliseconds since process init began.
    pub fn elapsed_ms(&self) -> u64 {
        self.startup.elapsed().as_millis() as u64
    }

    /// Record the cold-start time the first time the UI reports it ready.
    /// Subsequent calls (e.g. HMR reloads in dev) are ignored.
    pub fn record_cold_start(&self) -> u64 {
        let ms = self.elapsed_ms();
        let _ = self
            .cold_start_ms
            .compare_exchange(0, ms, Ordering::SeqCst, Ordering::SeqCst);
        self.cold_start_ms.load(Ordering::SeqCst)
    }

    /// The recorded cold-start time, or `None` if the UI hasn't reported yet.
    pub fn cold_start_ms(&self) -> Option<u64> {
        match self.cold_start_ms.load(Ordering::SeqCst) {
            0 => None,
            ms => Some(ms),
        }
    }
}
