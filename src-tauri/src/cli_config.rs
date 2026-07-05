//! User-global Claude Code CLI settings (Addendum III S16).
//!
//! Read + write the same `~/.claude/settings.json` keys the CLI's `/config`
//! panel manages — model/effort defaults, thinking, auto-compact, workflows,
//! theme, notifications, etc. A thin, faithful editor over the file the
//! installed CLI reads at session start: every key and enum value below was
//! verified against the installed binary (2.1.201, no `config` subcommand —
//! the `/config` TUI edits this file directly, so we do the same). Writes are
//! read-modify-write: keys we don't model (env, hooks, statusLine,
//! enabledPlugins, permissions…) are preserved untouched, and a malformed
//! (non-object) file is refused rather than clobbered. Keys the CLI persists
//! in `~/.claude.json` instead (terminal cosmetics like copy-on-select) are
//! deliberately out of scope — that file is volatile CLI state we never write.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::{IpcError, IpcErrorKind, IpcResult};

/// Cap on the settings file we'll parse — hand-sized config, not data.
const MAX_SETTINGS_BYTES: u64 = 1024 * 1024;
/// Free-text values (model id, output style, language) stay short.
const MAX_TEXT_LEN: usize = 200;

/// What a key's value must look like. `Enum` lists come from the installed
/// binary's own option arrays.
enum Kind {
    Bool,
    Enum(&'static [&'static str]),
    Text,
}

/// The allow-list: every key this module will read or write, all verified
/// against the CLI's `/config` panel code. `worktree.baseRef` is the one
/// nested key (stored as `{"worktree":{"baseRef":…}}`).
const KEYS: &[(&str, Kind)] = &[
    ("model", Kind::Text),
    ("effortLevel", Kind::Enum(&["low", "medium", "high", "xhigh"])),
    ("alwaysThinkingEnabled", Kind::Bool),
    ("useAutoModeDuringPlan", Kind::Bool),
    ("remoteControlAtStartup", Kind::Bool),
    ("autoCompactEnabled", Kind::Bool),
    ("precomputeCompactionEnabled", Kind::Bool),
    ("awaySummaryEnabled", Kind::Bool),
    ("promptSuggestionEnabled", Kind::Bool),
    ("askUserQuestionTimeout", Kind::Enum(&["never", "60s", "5m", "10m"])),
    ("verbose", Kind::Bool),
    ("outputStyle", Kind::Text),
    ("language", Kind::Text),
    (
        "theme",
        Kind::Enum(&[
            "auto",
            "dark",
            "light",
            "light-daltonized",
            "dark-daltonized",
            "light-ansi",
            "dark-ansi",
        ]),
    ),
    ("editorMode", Kind::Enum(&["normal", "vim"])),
    ("spinnerTipsEnabled", Kind::Bool),
    ("prefersReducedMotion", Kind::Bool),
    ("enableWorkflows", Kind::Bool),
    ("workflowKeywordTriggerEnabled", Kind::Bool),
    ("enableArtifact", Kind::Bool),
    ("worktree.baseRef", Kind::Enum(&["fresh", "head"])),
    (
        "preferredNotifChannel",
        Kind::Enum(&[
            "auto",
            "iterm2",
            "terminal_bell",
            "iterm2_with_bell",
            "kitty",
            "ghostty",
            "notifications_disabled",
        ]),
    ),
    ("inputNeededNotifEnabled", Kind::Bool),
    ("agentPushNotifEnabled", Kind::Bool),
];

/// What the UI reads: which modelled keys are explicitly set, and the file
/// path (for the "what am I editing" caption). Absent key = CLI default.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliConfigDoc {
    pub exists: bool,
    pub values: BTreeMap<String, Value>,
    pub path: String,
}

/// `~/.claude/settings.json` — fixed path, no caller input.
fn settings_path() -> IpcResult<PathBuf> {
    let home = crate::sessions::home_dir()
        .ok_or_else(|| internal("Could not resolve your home directory".into()))?;
    Ok(home.join(".claude").join("settings.json"))
}

pub fn read() -> IpcResult<CliConfigDoc> {
    let path = settings_path()?;
    read_at(&path)
}

/// Set (`Some`) or clear (`None`) one allow-listed key, preserving everything
/// else in the file byte-for-semantics. Like the CLI's own `/config`, this is
/// a read-modify-write with a tiny race window against a concurrently-running
/// CLI — the same window the CLI itself has between two of its sessions.
pub fn set(key: &str, value: Option<Value>) -> IpcResult<()> {
    let path = settings_path()?;
    set_at(&path, key, value)
}

fn read_at(path: &Path) -> IpcResult<CliConfigDoc> {
    let display = path.display().to_string();
    if !path.exists() {
        return Ok(CliConfigDoc {
            exists: false,
            values: BTreeMap::new(),
            path: display,
        });
    }
    let root = read_object(path)?;
    let mut values = BTreeMap::new();
    for (key, _) in KEYS {
        let found = match key.split_once('.') {
            Some((outer, inner)) => root.get(outer).and_then(|v| v.get(inner)),
            None => root.get(*key),
        };
        if let Some(v) = found {
            values.insert((*key).to_string(), v.clone());
        }
    }
    Ok(CliConfigDoc {
        exists: true,
        values,
        path: display,
    })
}

fn set_at(path: &Path, key: &str, value: Option<Value>) -> IpcResult<()> {
    let kind = KEYS
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, kind)| kind)
        .ok_or_else(|| invalid(&format!("\"{key}\" is not a setting this app manages")))?;
    let value = match value {
        Some(v) => Some(validated(key, kind, v)?),
        None => None,
    };

    let mut root = if path.exists() {
        read_object(path)?
    } else {
        Map::new()
    };

    match key.split_once('.') {
        Some((outer, inner)) => {
            match value {
                Some(v) => {
                    let slot = root
                        .entry(outer.to_string())
                        .or_insert_with(|| Value::Object(Map::new()));
                    let obj = slot.as_object_mut().ok_or_else(|| {
                        invalid(&format!("\"{outer}\" in settings.json isn't an object — fix it by hand first"))
                    })?;
                    obj.insert(inner.to_string(), v);
                }
                None => {
                    if let Some(obj) = root.get_mut(outer).and_then(Value::as_object_mut) {
                        obj.remove(inner);
                        if obj.is_empty() {
                            root.remove(outer);
                        }
                    }
                }
            }
        }
        None => {
            match value {
                Some(v) => {
                    root.insert(key.to_string(), v);
                }
                None => {
                    root.remove(key);
                }
            }
        }
    }

    let text = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|e| internal(format!("Could not serialize settings.json: {e}")))?
        + "\n";
    fs::write(path, text).map_err(|e| internal(format!("Could not write settings.json: {e}")))
}

/// Type-check a value against its key's kind; returns the (trimmed) value to
/// store. This is the trust boundary for the frontend's writes.
fn validated(key: &str, kind: &Kind, value: Value) -> IpcResult<Value> {
    match kind {
        Kind::Bool => {
            if value.is_boolean() {
                Ok(value)
            } else {
                Err(invalid(&format!("\"{key}\" must be true or false")))
            }
        }
        Kind::Enum(options) => match value.as_str() {
            Some(s) if options.contains(&s) => Ok(value),
            _ => Err(invalid(&format!(
                "\"{key}\" must be one of: {}",
                options.join(", ")
            ))),
        },
        Kind::Text => {
            let s = value
                .as_str()
                .ok_or_else(|| invalid(&format!("\"{key}\" must be a string")))?
                .trim();
            if s.is_empty() {
                return Err(invalid(&format!("\"{key}\" can't be empty — clear it instead")));
            }
            if s.len() > MAX_TEXT_LEN {
                return Err(invalid(&format!("\"{key}\" is too long (max {MAX_TEXT_LEN} chars)")));
            }
            if s.chars().any(char::is_control) {
                return Err(invalid(&format!("\"{key}\" contains control characters")));
            }
            Ok(Value::String(s.to_string()))
        }
    }
}

/// Read + parse the file, refusing anything that isn't a JSON object (we
/// merge into it — clobbering a broken file would destroy the user's config).
fn read_object(path: &Path) -> IpcResult<Map<String, Value>> {
    let meta =
        fs::metadata(path).map_err(|e| internal(format!("Could not read settings.json: {e}")))?;
    if meta.len() > MAX_SETTINGS_BYTES {
        return Err(invalid("~/.claude/settings.json is too large to edit safely"));
    }
    let text = fs::read_to_string(path)
        .map_err(|e| internal(format!("Could not read settings.json: {e}")))?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|e| invalid(&format!("~/.claude/settings.json is not valid JSON: {e}")))?;
    match value {
        Value::Object(map) => Ok(map),
        _ => Err(invalid(
            "~/.claude/settings.json is not a JSON object — refusing to overwrite it",
        )),
    }
}

fn internal(message: String) -> IpcError {
    IpcError::new(IpcErrorKind::Internal, &message)
}

fn invalid(message: &str) -> IpcError {
    IpcError::new(IpcErrorKind::InvalidInput, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static N: AtomicU32 = AtomicU32::new(0);

    fn temp_file() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cli-config-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir.join("settings.json")
    }

    #[test]
    fn set_read_round_trip_and_unset() {
        let path = temp_file();
        set_at(&path, "autoCompactEnabled", Some(Value::Bool(false))).unwrap();
        set_at(&path, "theme", Some(Value::String("light".into()))).unwrap();
        set_at(&path, "model", Some(Value::String("  claude-fable-5  ".into()))).unwrap();
        set_at(&path, "worktree.baseRef", Some(Value::String("head".into()))).unwrap();

        let doc = read_at(&path).unwrap();
        assert!(doc.exists);
        assert_eq!(doc.values["autoCompactEnabled"], Value::Bool(false));
        assert_eq!(doc.values["theme"], "light");
        assert_eq!(doc.values["model"], "claude-fable-5"); // trimmed
        assert_eq!(doc.values["worktree.baseRef"], "head");

        // Unset the nested key: the empty `worktree` object is pruned too.
        set_at(&path, "worktree.baseRef", None).unwrap();
        let raw: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(raw.get("worktree").is_none());
        // Unsetting a key that isn't there is a no-op, not an error.
        set_at(&path, "verbose", None).unwrap();
    }

    #[test]
    fn preserves_unmodelled_keys() {
        let path = temp_file();
        fs::write(
            &path,
            r#"{"env":{"FOO":"bar"},"statusLine":{"type":"command"},"permissions":{"allow":["Bash"]},"theme":"dark"}"#,
        )
        .unwrap();
        set_at(&path, "theme", Some(Value::String("auto".into()))).unwrap();
        let raw: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["env"]["FOO"], "bar");
        assert_eq!(raw["statusLine"]["type"], "command");
        assert_eq!(raw["permissions"]["allow"][0], "Bash");
        assert_eq!(raw["theme"], "auto");
    }

    #[test]
    fn rejects_unknown_keys_and_bad_values() {
        let path = temp_file();
        assert!(set_at(&path, "apiKeyHelper", Some(Value::Bool(true))).is_err());
        assert!(set_at(&path, "verbose", Some(Value::String("yes".into()))).is_err());
        assert!(set_at(&path, "theme", Some(Value::String("solarized".into()))).is_err());
        assert!(set_at(&path, "model", Some(Value::String("a".repeat(300)))).is_err());
        assert!(set_at(&path, "model", Some(Value::String("x\u{7}y".into()))).is_err());
        assert!(set_at(&path, "model", Some(Value::String("   ".into()))).is_err());
        // Nothing above may have created or corrupted the file.
        assert!(!path.exists());
    }

    #[test]
    fn refuses_non_object_file() {
        let path = temp_file();
        fs::write(&path, "[1,2,3]").unwrap();
        assert!(set_at(&path, "verbose", Some(Value::Bool(true))).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "[1,2,3]");
        assert!(read_at(&path).is_err());
    }

    #[test]
    fn missing_file_reads_empty_and_first_set_creates_it() {
        let path = temp_file();
        let doc = read_at(&path).unwrap();
        assert!(!doc.exists);
        assert!(doc.values.is_empty());
        set_at(&path, "editorMode", Some(Value::String("vim".into()))).unwrap();
        let doc = read_at(&path).unwrap();
        assert!(doc.exists);
        assert_eq!(doc.values["editorMode"], "vim");
    }
}
