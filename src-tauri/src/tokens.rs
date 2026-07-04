//! Global API-token store (GitHub / Hugging Face). One file —
//! `<app_config_dir>/tokens.json`, chmod 0600 — so a token is entered once and
//! every engine session and terminal reuses it via standard env vars
//! (`GITHUB_TOKEN`/`GH_TOKEN`, `HF_TOKEN`/`HUGGING_FACE_HUB_TOKEN`).
//!
//! Trust rules: providers are a fixed allow-list, tokens are validated as
//! single-line ASCII (data, never a command string), the full secret is never
//! sent back to the frontend (status returns a masked tail only), and a var
//! already set in the app's own environment always wins — we fill gaps, we
//! don't override the user's shell config.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;
use serde_json::Value;

use crate::error::{IpcError, IpcErrorKind, IpcResult};

/// The providers we model, with the env vars each one conventionally fills.
/// Two vars per provider because the ecosystems disagree: `gh` reads
/// `GH_TOKEN`, most CI/scripts read `GITHUB_TOKEN`; `huggingface_hub` reads
/// `HF_TOKEN` today and `HUGGING_FACE_HUB_TOKEN` historically.
const PROVIDERS: [(&str, [&str; 2]); 2] = [
    ("github", ["GITHUB_TOKEN", "GH_TOKEN"]),
    ("huggingface", ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"]),
];

/// Tokens are opaque strings, but real ones (ghp_…, github_pat_…, hf_…) are
/// short; bound defensively.
const MAX_TOKEN_LEN: usize = 512;
const MAX_FILE_BYTES: u64 = 64 * 1024;

/// Resolved once at app setup so `engine.rs`/`pty.rs` can inject tokens
/// without threading the Tauri config dir through every spawn signature.
static CONFIG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Called once from the app's `setup` hook.
pub fn init(config_dir: PathBuf) {
    let _ = CONFIG_DIR.set(config_dir);
}

/// `env_pairs` against the setup-time config dir; empty if setup never ran
/// (unit tests) so callers need no special case.
pub fn injectable_env() -> Vec<(String, String)> {
    CONFIG_DIR.get().map(|d| env_pairs(d)).unwrap_or_default()
}

fn tokens_path(config_dir: &Path) -> PathBuf {
    config_dir.join("tokens.json")
}

/// One provider's presence for the UI — never the secret itself.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenStatus {
    pub provider: String,
    /// `None` = not stored. `Some("…abcd")` = stored, masked to the last 4.
    pub masked: Option<String>,
    /// The env var was already set outside the app (shell profile, launcher);
    /// the stored token (if any) will NOT override it.
    pub env_overridden: bool,
}

fn valid_provider(provider: &str) -> IpcResult<&'static str> {
    PROVIDERS
        .iter()
        .map(|(p, _)| *p)
        .find(|p| *p == provider)
        .ok_or_else(|| {
            IpcError::new(
                IpcErrorKind::InvalidInput,
                "Unknown token provider (use github or huggingface)",
            )
        })
}

fn read_map(config_dir: &Path) -> IpcResult<BTreeMap<String, String>> {
    let path = tokens_path(config_dir);
    if !path.is_file() {
        return Ok(BTreeMap::new());
    }
    let len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if len > MAX_FILE_BYTES {
        return Err(IpcError::new(
            IpcErrorKind::InvalidInput,
            "tokens.json is unexpectedly large — refusing to parse it",
        ));
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| internal(format!("Could not read tokens.json: {e}")))?;
    let root: Value = serde_json::from_str(&text)
        .map_err(|e| internal(format!("tokens.json is not valid JSON: {e}")))?;
    let mut map = BTreeMap::new();
    if let Some(obj) = root.as_object() {
        for (k, v) in obj {
            if let Some(s) = v.as_str() {
                map.insert(k.clone(), s.to_owned());
            }
        }
    }
    Ok(map)
}

fn write_map(config_dir: &Path, map: &BTreeMap<String, String>) -> IpcResult<()> {
    std::fs::create_dir_all(config_dir)
        .map_err(|e| internal(format!("Could not create the config directory: {e}")))?;
    let path = tokens_path(config_dir);
    let mut text = serde_json::to_string_pretty(map)
        .map_err(|e| internal(format!("Could not serialize tokens: {e}")))?;
    text.push('\n');
    std::fs::write(&path, text)
        .map_err(|e| internal(format!("Could not write tokens.json: {e}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| internal(format!("Could not restrict tokens.json permissions: {e}")))?;
    }
    Ok(())
}

/// Presence/masked status for every modelled provider (never the secret).
pub fn status(config_dir: &Path) -> IpcResult<Vec<TokenStatus>> {
    let map = read_map(config_dir)?;
    Ok(PROVIDERS
        .iter()
        .map(|(provider, vars)| {
            let masked = map.get(*provider).map(|t| {
                let tail: String = t.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
                format!("…{tail}")
            });
            TokenStatus {
                provider: (*provider).to_owned(),
                masked,
                env_overridden: vars.iter().any(|v| std::env::var_os(v).is_some()),
            }
        })
        .collect())
}

/// Store (or replace) one provider's token.
pub fn set(config_dir: &Path, provider: &str, token: &str) -> IpcResult<()> {
    let provider = valid_provider(provider)?;
    let token = token.trim();
    if token.is_empty() {
        return Err(IpcError::new(IpcErrorKind::InvalidInput, "Token is empty"));
    }
    if token.len() > MAX_TOKEN_LEN {
        return Err(IpcError::new(IpcErrorKind::InvalidInput, "Token is too long"));
    }
    if !token.chars().all(|c| c.is_ascii_graphic()) {
        return Err(IpcError::new(
            IpcErrorKind::InvalidInput,
            "Token has whitespace or non-ASCII characters — paste the raw token only",
        ));
    }
    let mut map = read_map(config_dir)?;
    map.insert(provider.to_owned(), token.to_owned());
    write_map(config_dir, &map)
}

/// Remove one provider's token (idempotent).
pub fn clear(config_dir: &Path, provider: &str) -> IpcResult<()> {
    let provider = valid_provider(provider)?;
    let mut map = read_map(config_dir)?;
    if map.remove(provider).is_some() {
        write_map(config_dir, &map)?;
    }
    Ok(())
}

/// The env pairs to inject into a child (engine session or terminal PTY).
/// A var already present in the app's own environment is skipped — the user's
/// shell config always wins over the stored token.
pub fn env_pairs(config_dir: &Path) -> Vec<(String, String)> {
    let map = match read_map(config_dir) {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!("tokens.json unreadable; skipping token injection: {}", e.message);
            return Vec::new();
        }
    };
    let mut out = Vec::new();
    for (provider, vars) in PROVIDERS {
        if let Some(token) = map.get(provider) {
            for var in vars {
                if std::env::var_os(var).is_none() {
                    out.push((var.to_owned(), token.clone()));
                }
            }
        }
    }
    out
}

fn internal(message: String) -> IpcError {
    IpcError::new(IpcErrorKind::Internal, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_dir() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let mut p = std::env::temp_dir();
        p.push(format!(
            "claude-ide-tokens-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn set_status_clear_round_trip() {
        let dir = temp_dir();
        set(&dir, "github", "ghp_abcdef1234").unwrap();
        let st = status(&dir).unwrap();
        let gh = st.iter().find(|s| s.provider == "github").unwrap();
        assert_eq!(gh.masked.as_deref(), Some("…1234"));
        assert!(st.iter().find(|s| s.provider == "huggingface").unwrap().masked.is_none());

        // File is 0600 (owner-only).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(tokens_path(&dir)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        clear(&dir, "github").unwrap();
        let st = status(&dir).unwrap();
        assert!(st.iter().find(|s| s.provider == "github").unwrap().masked.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_bad_provider_and_bad_token() {
        let dir = temp_dir();
        assert!(matches!(set(&dir, "gitlab", "x").unwrap_err().kind, IpcErrorKind::InvalidInput));
        assert!(matches!(set(&dir, "github", "  ").unwrap_err().kind, IpcErrorKind::InvalidInput));
        assert!(matches!(
            set(&dir, "github", "has space").unwrap_err().kind,
            IpcErrorKind::InvalidInput
        ));
        assert!(matches!(
            set(&dir, "github", &"x".repeat(600)).unwrap_err().kind,
            IpcErrorKind::InvalidInput
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn env_pairs_skips_vars_already_in_environment() {
        let dir = temp_dir();
        set(&dir, "huggingface", "hf_zzzz9999").unwrap();
        let pairs = env_pairs(&dir);
        // HF_TOKEN / HUGGING_FACE_HUB_TOKEN appear unless the test env sets them.
        for var in ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"] {
            let injected = pairs.iter().any(|(k, _)| k == var);
            assert_eq!(injected, std::env::var_os(var).is_none());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
