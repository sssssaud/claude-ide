//! Project permission settings (P3 permission manager, spec 3.6 / Phase 7 7B).
//!
//! Read + write the workspace's SHARED, checked-in `.claude/settings.json`
//! `permissions` block — the allow / ask / deny rule lists, the default mode,
//! and any additional tool-access directories. This is a thin, faithful editor
//! over the very file the installed `claude` CLI reads: we invent no fields, and
//! never touch the gitignored `settings.local.json`, the user-global settings,
//! or managed policy. Writes are read-modify-write — every other key in
//! settings.json (and every permission sub-key we don't model) is preserved
//! untouched, and a malformed (non-object) file is refused rather than clobbered.
//!
//! The CLI stays the source of truth and the real permission boundary (it merges
//! managed + local + project + user scopes, deny over ask over allow). This edits
//! one scope's config file; the "would this prompt?" preview lives in the UI and
//! is explicitly non-authoritative.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{IpcError, IpcErrorKind, IpcResult};

/// Cap on the settings file we'll parse — it's hand-sized config, not data.
const MAX_SETTINGS_BYTES: u64 = 1024 * 1024;
/// Defensive bounds so a runaway UI can't write a pathological file.
const MAX_RULES_PER_LIST: usize = 1000;
const MAX_DIRS: usize = 200;
const MAX_RULE_LEN: usize = 2000;

/// The modes the CLI accepts for `permissions.defaultMode` (verified against the
/// Claude Code permission-modes docs). `None` means "omit the key" — the CLI
/// then applies its own default behaviour.
const DEFAULT_MODES: [&str; 4] = ["default", "acceptEdits", "plan", "bypassPermissions"];

/// The modelled slice of `permissions` (camelCase on the wire, matching the file).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPermissions {
    #[serde(default)]
    pub allow: Vec<String>,
    #[serde(default)]
    pub ask: Vec<String>,
    #[serde(default)]
    pub deny: Vec<String>,
    /// One of `DEFAULT_MODES`, or `None` to leave the key out of the file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_mode: Option<String>,
    #[serde(default)]
    pub additional_directories: Vec<String>,
}

/// What `read` returns: the parsed permissions plus whether the file exists yet
/// (so the UI can say "Save will create .claude/settings.json").
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPermissionsFile {
    pub exists: bool,
    pub permissions: ProjectPermissions,
}

/// Read the project's `.claude/settings.json` permissions (read-only; tolerant of
/// a missing file and of hand-edited extra keys).
pub fn read(cwd: Option<String>) -> IpcResult<ProjectPermissionsFile> {
    let path = settings_path(cwd)?;
    if !path.is_file() {
        return Ok(ProjectPermissionsFile {
            exists: false,
            permissions: ProjectPermissions::default(),
        });
    }
    let root = read_settings_value(&path)?;
    let permissions = root
        .get("permissions")
        .and_then(Value::as_object)
        .map(extract_permissions)
        .unwrap_or_default();
    Ok(ProjectPermissionsFile { exists: true, permissions })
}

/// Write the project's `.claude/settings.json` permissions block, preserving
/// every other key (read-modify-write). Creates `.claude/` + the file if absent.
pub fn write(cwd: Option<String>, permissions: ProjectPermissions) -> IpcResult<()> {
    let permissions = sanitize(permissions)?;
    let path = settings_path(cwd)?;

    // Read-modify-write so unrelated settings (hooks, env, model, …) survive. A
    // missing file starts from an empty object; a malformed one is refused, never
    // overwritten.
    let mut root = if path.is_file() {
        match read_settings_value(&path)? {
            Value::Object(map) => Value::Object(map),
            _ => {
                return Err(invalid(
                    ".claude/settings.json is not a JSON object — refusing to overwrite it",
                ))
            }
        }
    } else {
        Value::Object(Map::new())
    };

    apply_permissions(
        root.as_object_mut().expect("root constructed as an object"),
        &permissions,
    );

    // Ensure `.claude/` exists before writing. The path is built from the
    // canonical root + fixed `.claude/settings.json` literals (no caller-supplied
    // segments), so it cannot escape the workspace.
    let parent = path.parent().expect("settings path has a parent");
    fs::create_dir_all(parent)
        .map_err(|e| internal(format!("Could not create .claude/: {e}")))?;

    let mut text = serde_json::to_string_pretty(&root)
        .map_err(|e| internal(format!("Could not serialize settings: {e}")))?;
    text.push('\n');
    fs::write(&path, text).map_err(|e| internal(format!("Could not write settings.json: {e}")))
}

/// `<canonical workspace root>/.claude/settings.json` (fixed, in-root path).
fn settings_path(cwd: Option<String>) -> IpcResult<PathBuf> {
    let root = crate::workspace::resolve_cwd(cwd)?;
    let root = fs::canonicalize(&root)
        .map_err(|e| internal(format!("Cannot resolve the workspace root: {e}")))?;
    Ok(root.join(".claude").join("settings.json"))
}

fn read_settings_value(path: &Path) -> IpcResult<Value> {
    let len = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if len > MAX_SETTINGS_BYTES {
        return Err(invalid(".claude/settings.json is too large to edit safely"));
    }
    let text =
        fs::read_to_string(path).map_err(|e| internal(format!("Could not read settings.json: {e}")))?;
    if text.trim().is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    serde_json::from_str(&text)
        .map_err(|e| invalid(&format!(".claude/settings.json is not valid JSON: {e}")))
}

fn extract_permissions(obj: &Map<String, Value>) -> ProjectPermissions {
    ProjectPermissions {
        allow: string_array(obj, "allow"),
        ask: string_array(obj, "ask"),
        deny: string_array(obj, "deny"),
        default_mode: obj.get("defaultMode").and_then(Value::as_str).map(str::to_owned),
        additional_directories: string_array(obj, "additionalDirectories"),
    }
}

fn string_array(obj: &Map<String, Value>, key: &str) -> Vec<String> {
    obj.get(key)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default()
}

/// Trim, drop blanks, de-dupe (order-preserving), bound, and validate the mode —
/// so the UI can't write a pathological or invalid file.
fn sanitize(mut p: ProjectPermissions) -> IpcResult<ProjectPermissions> {
    p.allow = clean_list(p.allow, MAX_RULES_PER_LIST, "permission rule")?;
    p.ask = clean_list(p.ask, MAX_RULES_PER_LIST, "permission rule")?;
    p.deny = clean_list(p.deny, MAX_RULES_PER_LIST, "permission rule")?;
    p.additional_directories = clean_list(p.additional_directories, MAX_DIRS, "directory")?;
    p.default_mode = match p.default_mode {
        Some(m) => {
            let m = m.trim();
            if m.is_empty() {
                None
            } else if DEFAULT_MODES.contains(&m) {
                Some(m.to_owned())
            } else {
                return Err(invalid(
                    "Unknown defaultMode (use default, acceptEdits, plan, or bypassPermissions)",
                ));
            }
        }
        None => None,
    };
    Ok(p)
}

fn clean_list(items: Vec<String>, max: usize, label: &str) -> IpcResult<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for raw in items {
        let s = raw.trim();
        if s.is_empty() {
            continue;
        }
        if s.len() > MAX_RULE_LEN {
            return Err(invalid(&format!("A {label} is too long")));
        }
        if s.contains('\n') || s.contains('\r') {
            return Err(invalid(&format!("A {label} contains a line break")));
        }
        if !out.iter().any(|e| e == s) {
            out.push(s.to_owned());
        }
        if out.len() > max {
            return Err(invalid(&format!("Too many {label} entries")));
        }
    }
    Ok(out)
}

/// Merge the modelled keys into the existing `permissions` object, preserving any
/// sub-keys we don't model. Empty lists drop their key (keeps the file tidy and
/// the write idempotent); `None` mode removes `defaultMode`.
fn apply_permissions(root: &mut Map<String, Value>, p: &ProjectPermissions) {
    let perms = root
        .entry("permissions")
        .or_insert_with(|| Value::Object(Map::new()));
    if !perms.is_object() {
        *perms = Value::Object(Map::new());
    }
    let perms = perms.as_object_mut().expect("permissions set to an object");
    set_or_remove_array(perms, "allow", &p.allow);
    set_or_remove_array(perms, "ask", &p.ask);
    set_or_remove_array(perms, "deny", &p.deny);
    set_or_remove_array(perms, "additionalDirectories", &p.additional_directories);
    match &p.default_mode {
        Some(m) => {
            perms.insert("defaultMode".into(), Value::String(m.clone()));
        }
        None => {
            perms.remove("defaultMode");
        }
    }
}

fn set_or_remove_array(obj: &mut Map<String, Value>, key: &str, items: &[String]) {
    if items.is_empty() {
        obj.remove(key);
    } else {
        obj.insert(
            key.into(),
            Value::Array(items.iter().cloned().map(Value::String).collect()),
        );
    }
}

fn internal(message: String) -> IpcError {
    IpcError::new(IpcErrorKind::Internal, message)
}

fn invalid(message: &str) -> IpcError {
    IpcError::new(IpcErrorKind::InvalidInput, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A fresh, unique temp workspace dir (we created it, so cleaning it up is
    /// safe — unlike `~/.claude`, which is never touched).
    fn temp_ws() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let mut p = std::env::temp_dir();
        p.push(format!(
            "claude-ide-perm-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn opt(p: &Path) -> Option<String> {
        Some(p.to_string_lossy().into_owned())
    }

    #[test]
    fn read_reports_missing_file() {
        let ws = temp_ws();
        let got = read(opt(&ws)).unwrap();
        assert!(!got.exists);
        assert!(got.permissions.allow.is_empty());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn write_then_read_round_trips() {
        let ws = temp_ws();
        let perms = ProjectPermissions {
            allow: vec!["Bash(npm run test:*)".into()],
            ask: vec![],
            deny: vec!["Bash(rm:*)".into()],
            default_mode: Some("acceptEdits".into()),
            additional_directories: vec!["../shared".into()],
        };
        write(opt(&ws), perms).unwrap();

        let got = read(opt(&ws)).unwrap();
        assert!(got.exists);
        assert_eq!(got.permissions.allow, vec!["Bash(npm run test:*)".to_string()]);
        assert_eq!(got.permissions.deny, vec!["Bash(rm:*)".to_string()]);
        assert_eq!(got.permissions.default_mode.as_deref(), Some("acceptEdits"));
        assert_eq!(got.permissions.additional_directories, vec!["../shared".to_string()]);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn write_preserves_other_keys() {
        let ws = temp_ws();
        fs::create_dir_all(ws.join(".claude")).unwrap();
        fs::write(
            ws.join(".claude/settings.json"),
            r#"{ "model": "claude-opus-4-8", "permissions": { "deny": ["WebFetch"], "extraKey": 1 } }"#,
        )
        .unwrap();

        write(
            opt(&ws),
            ProjectPermissions { allow: vec!["Read(./src/**)".into()], ..Default::default() },
        )
        .unwrap();

        let raw = fs::read_to_string(ws.join(".claude/settings.json")).unwrap();
        let v: Value = serde_json::from_str(&raw).unwrap();
        // Unrelated top-level + unmodelled permission sub-keys survive.
        assert_eq!(v["model"], "claude-opus-4-8");
        assert_eq!(v["permissions"]["extraKey"], 1);
        // Our managed keys are applied; the cleared `deny` list is dropped.
        assert_eq!(v["permissions"]["allow"][0], "Read(./src/**)");
        assert!(v["permissions"].get("deny").is_none());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn write_refuses_non_object_file() {
        let ws = temp_ws();
        fs::create_dir_all(ws.join(".claude")).unwrap();
        fs::write(ws.join(".claude/settings.json"), "[1, 2, 3]").unwrap();
        let err = write(opt(&ws), ProjectPermissions::default()).unwrap_err();
        assert!(matches!(err.kind, IpcErrorKind::InvalidInput));
        // The malformed file is left exactly as it was (never clobbered).
        assert_eq!(fs::read_to_string(ws.join(".claude/settings.json")).unwrap(), "[1, 2, 3]");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn sanitize_trims_dedupes_and_validates_mode() {
        let cleaned = sanitize(ProjectPermissions {
            allow: vec!["  Bash(ls)  ".into(), "Bash(ls)".into(), "".into(), "Read(x)".into()],
            default_mode: Some("  ".into()), // blank -> dropped
            ..Default::default()
        })
        .unwrap();
        assert_eq!(cleaned.allow, vec!["Bash(ls)".to_string(), "Read(x)".to_string()]);
        assert!(cleaned.default_mode.is_none());

        let bad = sanitize(ProjectPermissions {
            default_mode: Some("yolo".into()),
            ..Default::default()
        });
        assert!(bad.is_err());
    }
}
