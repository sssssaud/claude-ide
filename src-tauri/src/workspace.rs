//! The workspace root — the single cwd the engine, terminal, and Sessions rail
//! all agree on (spec 3.2). Until the Phase 4/5 folder picker sets it
//! explicitly, it resolves from (in order): an explicit argument, the
//! `CLAUDE_IDE_WORKSPACE` env var (so `tauri dev` can point at the real project
//! root instead of cargo's `src-tauri/` run dir), then the launch directory —
//! with a dev guard: if that launch dir is `src-tauri/` (cargo's run dir under
//! `tauri dev`), fall back to its parent so the explorer, sessions, and git all
//! target the project even when the env var was forgotten. A release binary is
//! never launched from `src-tauri/`, so the guard can't misfire in production.
//!
//! Engine and Sessions sharing this is what makes "a new session appears live"
//! work: the session the engine creates lands in the same project dir the rail
//! is watching.

use std::path::PathBuf;

use crate::error::{IpcError, IpcErrorKind, IpcResult};

/// Resolve the workspace cwd. `explicit` (from `open_workspace`/`list_sessions`)
/// wins; then `CLAUDE_IDE_WORKSPACE`; then the process launch dir. The result is
/// verified to be an existing directory.
pub fn resolve_cwd(explicit: Option<String>) -> IpcResult<PathBuf> {
    let path = match explicit {
        Some(c) if !c.trim().is_empty() => PathBuf::from(c.trim()),
        _ => match std::env::var("CLAUDE_IDE_WORKSPACE") {
            Ok(v) if !v.trim().is_empty() => PathBuf::from(v.trim()),
            _ => {
                let cwd = std::env::current_dir().map_err(|e| {
                    IpcError::new(
                        IpcErrorKind::Internal,
                        format!("Cannot resolve a working directory: {e}"),
                    )
                })?;
                // Dev guard: `tauri dev` runs the binary from `src-tauri/`; the
                // real workspace root is its parent.
                match (cwd.file_name(), cwd.parent()) {
                    (Some(name), Some(parent)) if name == "src-tauri" => parent.to_path_buf(),
                    _ => cwd,
                }
            }
        },
    };
    if !path.is_dir() {
        return Err(IpcError::new(
            IpcErrorKind::InvalidInput,
            format!("Working directory does not exist: {}", path.display()),
        ));
    }
    Ok(path)
}
