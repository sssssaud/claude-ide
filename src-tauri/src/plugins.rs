//! Plugins & Skills — read-only status for Settings (Addendum III §S11).
//!
//! As a wrapper we never manage plugin/skill installation ourselves — the CLI
//! owns that (`claude plugin install`/`marketplace add`/`init`, etc., all
//! real, already-interactive commands). This module only surfaces its own
//! authoritative view via `claude plugin list --json` and `claude plugin
//! marketplace list --json`, so Settings can show what's actually installed
//! instead of a blind link out. Every mutating action (install, enable/
//! disable, uninstall, add a marketplace, scaffold a new skill) runs through
//! `InlineTerminal` on the frontend — the CLI's own command, typed into a real
//! shell exactly as a user would — never a new hand-rolled mutation path here.

use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, IpcError, IpcErrorKind, IpcResult};

/// One entry from `claude plugin list --json`. Every field optional so a CLI
/// schema drift can't break the view (mirrors `agents.rs::AgentSession`). A
/// skill (scaffolded under `~/.claude/skills/`) shows up here too, with an
/// `id` ending in `@skills-dir` — the frontend splits the two for display,
/// this module stays a faithful, uninterpreted mirror.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PluginEntry {
    pub id: Option<String>,
    pub version: Option<String>,
    /// "user" | "project" | … (whatever the CLI reports).
    pub scope: Option<String>,
    pub enabled: Option<bool>,
    pub install_path: Option<String>,
}

/// One entry from `claude plugin marketplace list --json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MarketplaceEntry {
    pub name: Option<String>,
    /// "github" | "url" | "path" | … (whatever the CLI reports).
    pub source: Option<String>,
    pub repo: Option<String>,
    pub url: Option<String>,
    pub path: Option<String>,
    pub install_location: Option<String>,
}

/// List installed plugins (and skills — the CLI reports both through the same
/// command). Read-only; runs on a blocking thread (spawns a short-lived process).
pub async fn list_plugins() -> IpcResult<Vec<PluginEntry>> {
    tauri::async_runtime::spawn_blocking(|| run_json_array(&["plugin", "list", "--json"]))
        .await
        .map_err(|e| IpcError::from(AppError::Io(std::io::Error::other(e.to_string()))))?
}

/// List configured marketplaces. Read-only.
pub async fn list_marketplaces() -> IpcResult<Vec<MarketplaceEntry>> {
    tauri::async_runtime::spawn_blocking(|| {
        run_json_array(&["plugin", "marketplace", "list", "--json"])
    })
    .await
    .map_err(|e| IpcError::from(AppError::Io(std::io::Error::other(e.to_string()))))?
}

fn run_json_array<T: for<'de> Deserialize<'de>>(args: &[&str]) -> IpcResult<Vec<T>> {
    let claude = crate::claude_bin::path()?;
    let out = Command::new(claude).args(args).output().map_err(|e| {
        IpcError::new(IpcErrorKind::Internal, format!("Could not run `claude {}`: {e}", args.join(" ")))
    })?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let line = stderr
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("command failed");
        return Err(IpcError::new(IpcErrorKind::Internal, line.to_string()));
    }
    Ok(parse_array(&String::from_utf8_lossy(&out.stdout)))
}

/// Tolerant array parse: a non-array or junk payload yields an empty list
/// rather than an error (the command already succeeded); an element that
/// doesn't match the shape is dropped rather than failing the whole list
/// (mirrors `agents.rs::parse_sessions`).
fn parse_array<T: for<'de> Deserialize<'de>>(stdout: &str) -> Vec<T> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    match serde_json::from_str::<Vec<T>>(trimmed) {
        Ok(list) => list,
        Err(_) => match serde_json::from_str::<Vec<Value>>(trimmed) {
            Ok(values) => values.into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect(),
            Err(_) => Vec::new(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_real_plugin_list_shape() {
        let raw = r#"[
            {"id":"code-review@claude-plugins-official","version":"unknown","scope":"user","enabled":true,"installPath":"/x/code-review"},
            {"id":"aeo@skills-dir","version":"2.9.0","scope":"user","enabled":true,"installPath":"/x/skills/aeo"}
        ]"#;
        let entries: Vec<PluginEntry> = parse_array(raw);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id.as_deref(), Some("code-review@claude-plugins-official"));
        assert_eq!(entries[1].id.as_deref(), Some("aeo@skills-dir"));
        assert_eq!(entries[1].version.as_deref(), Some("2.9.0"));
    }

    #[test]
    fn parses_real_marketplace_list_shape() {
        let raw = r#"[{"name":"claude-plugins-official","source":"github","repo":"anthropics/claude-plugins-official","installLocation":"/x/marketplaces/claude-plugins-official"}]"#;
        let entries: Vec<MarketplaceEntry> = parse_array(raw);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name.as_deref(), Some("claude-plugins-official"));
        assert_eq!(entries[0].repo.as_deref(), Some("anthropics/claude-plugins-official"));
    }

    #[test]
    fn empty_and_junk_stdout_yield_empty_list() {
        assert!(parse_array::<PluginEntry>("").is_empty());
        assert!(parse_array::<PluginEntry>("not json").is_empty());
        assert!(parse_array::<PluginEntry>("{}").is_empty());
    }

    #[test]
    fn drops_unparseable_elements_keeps_the_rest() {
        let raw = r#"[{"id":"good@x","enabled":true}, "just a string", {"id":"also-good@x"}]"#;
        let entries: Vec<PluginEntry> = parse_array(raw);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id.as_deref(), Some("good@x"));
        assert_eq!(entries[1].id.as_deref(), Some("also-good@x"));
    }
}
