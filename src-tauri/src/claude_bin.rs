//! Single source of truth for the absolute `claude` binary path (hardening B1).
//!
//! Resolved via `which` and cached, so every spawn site — the engine session,
//! preflight, auth, the agents dashboard — uses the same validated **absolute**
//! path instead of re-resolving a bare `claude` through `$PATH` at spawn time.
//! That closes a PATH-hijack window (a malicious `claude` planted earlier in
//! `$PATH` after launch can't be picked up mid-run) and guarantees one
//! consistent binary across the whole app.
//!
//! The resolution is **sticky once found, retryable while absent**: once
//! `claude` is located and trusted, it is never re-resolved for the life of the
//! process (no swap-after-trust — the B1 guarantee). But if it was *not* found
//! yet, there is nothing trusted to protect, so each call re-probes PATH — this
//! is what lets someone install Claude Code CLI after Claude IDE is already
//! open and have Preflight's Retry check actually pick it up, instead of
//! requiring a full relaunch.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::error::{IpcError, IpcErrorKind, IpcResult};

/// `Some(path)` once `claude` has been found and trusted; `None` while it's
/// still absent (in which case the next call re-probes). The path is leaked to
/// `'static` on the one occasion it's found, so callers keep a plain `&'static
/// Path` — this leaks at most once per process, not per retry.
static CLAUDE_PATH: OnceLock<Mutex<Option<&'static Path>>> = OnceLock::new();

fn cell() -> &'static Mutex<Option<&'static Path>> {
    CLAUDE_PATH.get_or_init(|| Mutex::new(probe()))
}

/// One `which("claude")` lookup, validated absolute and leaked to `'static`.
fn probe() -> Option<&'static Path> {
    which::which("claude")
        .ok()
        .and_then(ensure_absolute)
        .map(|p| -> &'static Path { Box::leak(p.into_boxed_path()) })
}

/// Resolve (and cache, if found) the absolute `claude` path. Call once from
/// `run()` before any command can spawn the CLI; idempotent if called again.
pub fn init() {
    let _ = resolved();
}

/// The cached resolution — re-probing PATH only while it's still unresolved
/// (see the module doc for why that's safe).
fn resolved() -> Option<&'static Path> {
    resolve_with(cell(), probe)
}

/// The sticky-once-found/retry-while-absent policy itself, factored out of
/// `resolved()` so it's testable against a fake probe (not the real filesystem
/// or the real global cache).
fn resolve_with(
    slot: &Mutex<Option<&'static Path>>,
    probe: impl FnOnce() -> Option<&'static Path>,
) -> Option<&'static Path> {
    let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        *guard = probe();
    }
    *guard
}

/// Enforce the absolute-path invariant. `which` already returns absolute paths;
/// this makes the guarantee structural (and testable) and rejects any resolver
/// that ever hands back a relative path — which would reintroduce the
/// spawn-time `$PATH` lookup B1 exists to remove.
fn ensure_absolute(p: PathBuf) -> Option<PathBuf> {
    p.is_absolute().then_some(p)
}

/// The resolved absolute `claude` path, or an `Internal` error if `claude` is
/// not on PATH. Every spawn site calls this instead of `Command::new("claude")`.
pub fn path() -> IpcResult<&'static Path> {
    match resolved() {
        Some(p) => Ok(p),
        None => Err(IpcError::new(
            IpcErrorKind::Internal,
            "`claude` was not found on PATH",
        )),
    }
}

/// The resolved path if present, else `None` — for callers (preflight) that
/// report absence as a normal state rather than an error.
pub fn path_opt() -> Option<&'static Path> {
    resolved()
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

    #[test]
    fn retries_while_absent_then_locks_in_once_found() {
        use std::sync::atomic::{AtomicU32, Ordering};

        let fake: &'static Path = Box::leak(PathBuf::from("/opt/fake/claude").into_boxed_path());
        let slot: Mutex<Option<&'static Path>> = Mutex::new(None);
        let calls = AtomicU32::new(0);

        // Still absent: every call re-probes (so installing the CLI mid-session
        // and clicking Retry check actually re-checks PATH).
        assert_eq!(
            resolve_with(&slot, || {
                calls.fetch_add(1, Ordering::SeqCst);
                None
            }),
            None
        );
        assert_eq!(
            resolve_with(&slot, || {
                calls.fetch_add(1, Ordering::SeqCst);
                None
            }),
            None
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2, "each miss should re-probe");

        // Now found: locks in.
        assert_eq!(
            resolve_with(&slot, || {
                calls.fetch_add(1, Ordering::SeqCst);
                Some(fake)
            }),
            Some(fake)
        );
        assert_eq!(calls.load(Ordering::SeqCst), 3);

        // A later call never probes again, even if the probe would now report
        // absent — once trusted, never re-resolved (hardening B1).
        assert_eq!(
            resolve_with(&slot, || {
                calls.fetch_add(1, Ordering::SeqCst);
                None
            }),
            Some(fake)
        );
        assert_eq!(calls.load(Ordering::SeqCst), 3, "a found path must never be re-probed");
    }
}
