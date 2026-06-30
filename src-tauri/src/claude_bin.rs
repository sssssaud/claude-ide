//! Single source of truth for the absolute `claude` binary path (hardening B1).
//!
//! Resolved once at startup via `which` and cached in a `OnceLock`, so every
//! spawn site — the engine session, preflight, the agents dashboard — uses the
//! same validated **absolute** path instead of re-resolving a bare `claude`
//! through `$PATH` at spawn time. That closes a PATH-hijack window (a malicious
//! `claude` planted earlier in `$PATH` after launch can't be picked up mid-run)
//! and guarantees one consistent binary across the whole app.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::error::{IpcError, IpcErrorKind, IpcResult};

/// Cached resolution: `Some(path)` if `claude` was found at startup, `None` if
/// it was absent. Set once; never re-resolved.
static CLAUDE_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Resolve and cache the absolute `claude` path. Call once from `run()` before
/// any command can spawn the CLI; idempotent if called again.
pub fn init() {
    let _ = resolved();
}

/// The cached resolution, resolving on first use so any pre-`init` caller (or a
/// unit test) still gets the correct one-time answer.
fn resolved() -> &'static Option<PathBuf> {
    CLAUDE_PATH.get_or_init(|| which::which("claude").ok().and_then(ensure_absolute))
}

/// Enforce the absolute-path invariant. `which` already returns absolute paths;
/// this makes the guarantee structural (and testable) and rejects any resolver
/// that ever hands back a relative path — which would reintroduce the
/// spawn-time `$PATH` lookup B1 exists to remove.
fn ensure_absolute(p: PathBuf) -> Option<PathBuf> {
    p.is_absolute().then_some(p)
}

/// The resolved absolute `claude` path, or an `Internal` error if `claude` was
/// not on PATH at startup. Every spawn site calls this instead of
/// `Command::new("claude")`.
pub fn path() -> IpcResult<&'static Path> {
    match resolved() {
        Some(p) => Ok(p.as_path()),
        None => Err(IpcError::new(
            IpcErrorKind::Internal,
            "`claude` was not found on PATH",
        )),
    }
}

/// The resolved path if present, else `None` — for callers (preflight) that
/// report absence as a normal state rather than an error.
pub fn path_opt() -> Option<&'static Path> {
    resolved().as_deref()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_relative_paths() {
        assert_eq!(ensure_absolute(PathBuf::from("claude")), None);
        assert_eq!(ensure_absolute(PathBuf::from("./bin/claude")), None);
        assert_eq!(ensure_absolute(PathBuf::from("../claude")), None);
    }

    #[test]
    fn keeps_absolute_paths() {
        let abs = PathBuf::from("/usr/local/bin/claude");
        assert_eq!(ensure_absolute(abs.clone()), Some(abs));
    }

    #[test]
    fn resolved_path_is_always_absolute() {
        // Environment-independent: if `claude` is installed here the cached path
        // must be absolute; if it isn't, `path()` errors — never a relative path.
        match path() {
            Ok(p) => assert!(p.is_absolute(), "cached claude path must be absolute"),
            Err(_) => { /* not installed in this environment (e.g. CI) — fine */ }
        }
    }
}
