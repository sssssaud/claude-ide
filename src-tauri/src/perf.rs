//! Performance instrumentation for the Phase 0 budgets (spec 2.7).
//!
//! Phase 0 measures two budgets on the reference machine: cold-start time and
//! idle RSS of the IDE process (excluding any child `claude` — there is none
//! yet in Phase 0, which is exactly why this is the right place to capture the
//! WebKitGTK baseline). Numbers are sampled, not assumed.

use serde::Serialize;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

/// A perf snapshot, mirrored in `src/ipc/types.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfStats {
    /// Cold-start time once the UI has reported ready; `None` until then.
    pub cold_start_ms: Option<u64>,
    /// Resident set size of this process, in bytes.
    pub rss_bytes: u64,
    /// Same value in MB, rounded to one decimal, for display.
    pub rss_mb: f64,
}

/// Sample this process's resident memory. Refreshes only the current PID so the
/// call is cheap enough to poll from a dev-only perf readout.
pub fn sample_rss_bytes() -> u64 {
    let pid = match sysinfo::get_current_pid() {
        Ok(pid) => pid,
        Err(e) => {
            tracing::warn!(error = %e, "could not resolve current pid for RSS sample");
            return 0;
        }
    };
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing().with_memory(),
    );
    sys.process(pid).map(|p| p.memory()).unwrap_or(0)
}

pub fn stats(cold_start_ms: Option<u64>) -> PerfStats {
    let rss_bytes = sample_rss_bytes();
    PerfStats {
        cold_start_ms,
        rss_bytes,
        rss_mb: (rss_bytes as f64 / 1_048_576.0 * 10.0).round() / 10.0,
    }
}

/// Opt-in durable cold-start marker. Writes `<temp>/claude-ide-cold-start.txt`
/// only when `CLAUDE_IDE_PERF_MARKER` is set, so it adds nothing to normal
/// runs. Used to measure the cold-start budget reliably when a detached GUI's
/// stderr isn't easily captured (the WebKitGTK reality on this platform).
pub fn mark_cold_start(ms: u64) {
    if std::env::var_os("CLAUDE_IDE_PERF_MARKER").is_none() {
        return;
    }
    let path = std::env::temp_dir().join("claude-ide-cold-start.txt");
    match std::fs::write(&path, format!("{ms}\n")) {
        Ok(()) => tracing::debug!(?path, ms, "wrote cold-start marker"),
        Err(e) => tracing::warn!(error = %e, "failed to write cold-start marker"),
    }
}
