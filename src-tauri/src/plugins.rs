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

use std::fs;
use std::path::Path;
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

/// One installable plugin, read from a marketplace's own manifest — there is no
/// `claude plugin` command that lists *available* (vs installed) plugins, so we
/// read the manifest the CLI already cloned to each marketplace's
/// `installLocation` (`.claude-plugin/marketplace.json`). Read-only, same as
/// reading session transcripts; install still runs the CLI's own `plugin
/// install <name>@<marketplace>` through `InlineTerminal`.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailablePlugin {
    pub name: Option<String>,
    pub description: Option<String>,
    pub category: Option<String>,
    pub author: Option<String>,
    /// The marketplace this entry came from (for `install name@marketplace`).
    pub marketplace: Option<String>,
}

/// Enumerate installable plugins across every configured marketplace by reading
/// each one's manifest. A marketplace with no readable/parseable manifest is
/// skipped (never fabricated); order follows marketplace order then manifest
/// order.
pub async fn list_available_plugins() -> IpcResult<Vec<AvailablePlugin>> {
    let marketplaces = list_marketplaces().await?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        for m in &marketplaces {
            let Some(loc) = m.install_location.as_deref() else { continue };
            let manifest = Path::new(loc).join(".claude-plugin").join("marketplace.json");
            let Ok(text) = fs::read_to_string(&manifest) else { continue };
            out.extend(parse_manifest_plugins(&text, m.name.as_deref()));
        }
        Ok(out)
    })
    .await
    .map_err(|e| IpcError::from(AppError::Io(std::io::Error::other(e.to_string()))))?
}

/// Parse the `plugins[]` array out of a marketplace manifest. Tolerant: a
/// missing/mis-typed `plugins` key yields an empty list; `author` may be a
/// `{name}` object or a bare string.
fn parse_manifest_plugins(text: &str, marketplace: Option<&str>) -> Vec<AvailablePlugin> {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return Vec::new() };
    let Some(arr) = v.get("plugins").and_then(Value::as_array) else { return Vec::new() };
    arr.iter()
        .map(|p| AvailablePlugin {
            name: str_field(p, "name"),
            description: str_field(p, "description"),
            category: str_field(p, "category"),
            author: p
                .get("author")
                .and_then(|a| a.get("name"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| str_field(p, "author")),
            marketplace: marketplace.map(str::to_string),
        })
        .collect()
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
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

    #[test]
    fn parses_marketplace_manifest_plugins() {
        // Shape taken from the real anthropics/claude-plugins-official manifest.
        let raw = r#"{
            "name": "claude-plugins-official",
            "plugins": [
                {"name":"42crunch-api-security-testing","description":"Automate API security","author":{"name":"42Crunch"},"category":"security","source":{"source":"git-subdir"}},
                {"name":"code-review","description":"Review diffs","author":"Anthropic","category":"dev"}
            ]
        }"#;
        let plugins = parse_manifest_plugins(raw, Some("claude-plugins-official"));
        assert_eq!(plugins.len(), 2);
        assert_eq!(plugins[0].name.as_deref(), Some("42crunch-api-security-testing"));
        assert_eq!(plugins[0].author.as_deref(), Some("42Crunch")); // object {name}
        assert_eq!(plugins[0].category.as_deref(), Some("security"));
        assert_eq!(plugins[0].marketplace.as_deref(), Some("claude-plugins-official"));
        assert_eq!(plugins[1].author.as_deref(), Some("Anthropic")); // bare string
    }

    #[test]
    fn manifest_without_plugins_key_is_empty() {
        assert!(parse_manifest_plugins("{}", Some("m")).is_empty());
        assert!(parse_manifest_plugins("not json", Some("m")).is_empty());
        assert!(parse_manifest_plugins(r#"{"plugins":"nope"}"#, Some("m")).is_empty());
    }
}
