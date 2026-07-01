//! App settings (Addendum II §1 / S1). The IDE's *own* preferences — distinct
//! from the `claude` CLI's `.claude/settings.json` (that's `permissions.rs`).
//!
//! Persisted to the app's `app_config_dir()/settings.json` (resolved by the
//! caller in `commands.rs`), **never** `~/.claude`. The document holds two
//! scopes — a global `user` block and per-workspace overrides keyed by canonical
//! path — and the frontend computes the effective value as
//! `defaults < user < workspace`. Every value is **data, never code**: numbers
//! are clamped, string enums checked against an allow-list, and writes are
//! read-modify-write so unknown keys (a newer app version's, or a hand-edit)
//! survive untouched. A malformed (non-object) file is refused on write rather
//! than clobbered. The fixed file path takes no caller-supplied segment, so a
//! write can never escape the config dir (§5.1 / §5.8).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{IpcError, IpcErrorKind, IpcResult};

/// Cap on the settings file we'll parse — it's hand-sized config, not data.
const MAX_SETTINGS_BYTES: u64 = 1024 * 1024;
/// Bound the number of per-workspace override blocks a runaway UI could write.
const MAX_WORKSPACES: usize = 500;
/// A workspace key is a canonical path used only as a map key (never an FS path
/// here); bound its length defensively.
const MAX_KEY_LEN: usize = 4096;
/// Font family is a CSS font stack, not prose; keep it sane.
const MAX_FONT_FAMILY_LEN: usize = 200;

/// Editor font size bounds (Monaco accepts a wide range; these are sane limits).
const FONT_SIZE_MIN: u16 = 6;
const FONT_SIZE_MAX: u16 = 72;
/// Word-wrap column bounds (only meaningful for the bounded/column modes).
const WRAP_COLUMN_MIN: u16 = 20;
const WRAP_COLUMN_MAX: u16 = 400;
/// Tab size bounds.
const TAB_SIZE_MIN: u16 = 1;
const TAB_SIZE_MAX: u16 = 16;

/// The `wordWrap` values Monaco understands (verified against `editor.IEditorOptions`).
const WORD_WRAP_MODES: [&str; 4] = ["off", "on", "wordWrapColumn", "bounded"];

/// The `autoSave` modes the frontend understands (Addendum II §1.2, S2).
const AUTO_SAVE_MODES: [&str; 4] = ["off", "afterDelay", "onFocusChange", "onWindowChange"];
/// Auto-save delay bounds, only meaningful for the `afterDelay` mode.
const AUTO_SAVE_DELAY_MIN: u32 = 200;
const AUTO_SAVE_DELAY_MAX: u32 = 60_000;

/// The modelled editor settings. **Every field is optional**: a present value is
/// an explicit override, an absent one means "fall through" to the lower scope or
/// the frontend default. camelCase on the wire (the file is hand-editable).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_ligatures: Option<bool>,
    /// One of `WORD_WRAP_MODES`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub word_wrap: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub word_wrap_column: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_size: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub insert_spaces: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimap: Option<bool>,
    /// Run the registered formatter (if any) on save (Addendum II §1.2, S2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format_on_save: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format_on_paste: Option<bool>,
    /// Strip trailing whitespace on save (skipped for Markdown — trailing spaces
    /// are a significant hard-break there).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trim_trailing_whitespace: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub insert_final_newline: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trim_final_newlines: Option<bool>,
    /// One of `AUTO_SAVE_MODES`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_save: Option<String>,
    /// Delay in ms, only meaningful when `auto_save` is `afterDelay`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_save_delay: Option<u32>,
}

/// One scope's settings (a category bag; only `editor` exists in S1, more land
/// in later slices as sibling keys).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeSettings {
    #[serde(default)]
    pub editor: EditorSettings,
}

/// The whole settings document the UI reads: the global scope plus every
/// per-workspace override block (keyed by canonical path). Tiny; returned whole.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsDoc {
    pub user: ScopeSettings,
    pub workspaces: BTreeMap<String, ScopeSettings>,
}

/// Which scope a write targets.
pub enum Scope {
    User,
    /// Per-workspace override, keyed by the workspace's canonical path.
    Workspace(String),
}

/// `<app_config_dir>/settings.json` (fixed; no caller-supplied path segment).
fn settings_path(config_dir: &Path) -> PathBuf {
    config_dir.join("settings.json")
}

/// Read the whole settings document (read-only; tolerant of a missing file and of
/// hand-edited extra keys — unknown keys are simply ignored on read).
pub fn read(config_dir: &Path) -> IpcResult<SettingsDoc> {
    let path = settings_path(config_dir);
    if !path.is_file() {
        return Ok(SettingsDoc::default());
    }
    let root = read_settings_value(&path)?;
    let obj = match root.as_object() {
        Some(o) => o,
        None => return Ok(SettingsDoc::default()),
    };

    let user = obj
        .get("user")
        .and_then(Value::as_object)
        .map(extract_scope)
        .unwrap_or_default();

    let mut workspaces = BTreeMap::new();
    if let Some(ws) = obj.get("workspaces").and_then(Value::as_object) {
        for (key, val) in ws {
            if let Some(scope_obj) = val.as_object() {
                workspaces.insert(key.clone(), extract_scope(scope_obj));
            }
        }
    }

    Ok(SettingsDoc { user, workspaces })
}

/// Write one scope's editor settings, preserving every other key in the document
/// (read-modify-write). Creates the config dir + file if absent; refuses (never
/// overwrites) a malformed non-object file. Values are validated/clamped first.
pub fn write(config_dir: &Path, scope: Scope, editor: EditorSettings) -> IpcResult<()> {
    let editor = sanitize_editor(editor)?;
    let path = settings_path(config_dir);

    // Read-modify-write so unrelated scopes / future keys survive. Missing file
    // starts from an empty object; a malformed one is refused, never overwritten.
    let mut root = if path.is_file() {
        match read_settings_value(&path)? {
            Value::Object(map) => Value::Object(map),
            _ => {
                return Err(invalid(
                    "settings.json is not a JSON object — refusing to overwrite it",
                ))
            }
        }
    } else {
        Value::Object(Map::new())
    };

    let root_obj = root.as_object_mut().expect("root constructed as an object");
    let scope_obj = match &scope {
        Scope::User => object_at(root_obj, "user"),
        Scope::Workspace(key) => {
            let key = key.trim();
            if key.is_empty() {
                return Err(invalid("Workspace key is empty"));
            }
            if key.len() > MAX_KEY_LEN {
                return Err(invalid("Workspace key is too long"));
            }
            let workspaces = object_at(root_obj, "workspaces");
            if !workspaces.contains_key(key) && workspaces.len() >= MAX_WORKSPACES {
                return Err(invalid("Too many per-workspace settings overrides"));
            }
            object_at(workspaces, key)
        }
    };

    apply_editor(object_at(scope_obj, "editor"), &editor);

    // Ensure the config dir exists. The path is `config_dir` + the fixed literal
    // `settings.json` (no caller segment), so it cannot escape the config dir.
    std::fs::create_dir_all(config_dir)
        .map_err(|e| internal(format!("Could not create the config directory: {e}")))?;

    let mut text = serde_json::to_string_pretty(&root)
        .map_err(|e| internal(format!("Could not serialize settings: {e}")))?;
    text.push('\n');
    std::fs::write(&path, text).map_err(|e| internal(format!("Could not write settings.json: {e}")))
}

fn read_settings_value(path: &Path) -> IpcResult<Value> {
    let len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if len > MAX_SETTINGS_BYTES {
        return Err(invalid("settings.json is too large to edit safely"));
    }
    let text = std::fs::read_to_string(path)
        .map_err(|e| internal(format!("Could not read settings.json: {e}")))?;
    if text.trim().is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    serde_json::from_str(&text).map_err(|e| invalid(&format!("settings.json is not valid JSON: {e}")))
}

/// Get a mutable object at `key`, inserting (or replacing a non-object) as needed.
fn object_at<'a>(obj: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    let entry = obj.entry(key).or_insert_with(|| Value::Object(Map::new()));
    if !entry.is_object() {
        *entry = Value::Object(Map::new());
    }
    entry.as_object_mut().expect("entry set to an object")
}

fn extract_scope(obj: &Map<String, Value>) -> ScopeSettings {
    let editor = obj
        .get("editor")
        .and_then(Value::as_object)
        .map(extract_editor)
        .unwrap_or_default();
    ScopeSettings { editor }
}

fn extract_editor(obj: &Map<String, Value>) -> EditorSettings {
    EditorSettings {
        font_family: obj.get("fontFamily").and_then(Value::as_str).map(str::to_owned),
        font_size: obj.get("fontSize").and_then(Value::as_u64).map(|n| n as u16),
        font_ligatures: obj.get("fontLigatures").and_then(Value::as_bool),
        word_wrap: obj.get("wordWrap").and_then(Value::as_str).map(str::to_owned),
        word_wrap_column: obj.get("wordWrapColumn").and_then(Value::as_u64).map(|n| n as u16),
        tab_size: obj.get("tabSize").and_then(Value::as_u64).map(|n| n as u16),
        insert_spaces: obj.get("insertSpaces").and_then(Value::as_bool),
        minimap: obj.get("minimap").and_then(Value::as_bool),
        format_on_save: obj.get("formatOnSave").and_then(Value::as_bool),
        format_on_paste: obj.get("formatOnPaste").and_then(Value::as_bool),
        trim_trailing_whitespace: obj.get("trimTrailingWhitespace").and_then(Value::as_bool),
        insert_final_newline: obj.get("insertFinalNewline").and_then(Value::as_bool),
        trim_final_newlines: obj.get("trimFinalNewlines").and_then(Value::as_bool),
        auto_save: obj.get("autoSave").and_then(Value::as_str).map(str::to_owned),
        auto_save_delay: obj.get("autoSaveDelay").and_then(Value::as_u64).map(|n| n as u32),
    }
}

/// Clamp numbers, validate the wrap enum, trim/bound the font family. Reject only
/// the one thing that can't be coerced safely (an unknown enum value).
fn sanitize_editor(mut e: EditorSettings) -> IpcResult<EditorSettings> {
    e.font_family = match e.font_family {
        Some(f) => {
            let f = f.trim();
            if f.is_empty() {
                None
            } else if f.len() > MAX_FONT_FAMILY_LEN {
                return Err(invalid("Font family is too long"));
            } else if f.contains('\n') || f.contains('\r') {
                return Err(invalid("Font family contains a line break"));
            } else {
                Some(f.to_owned())
            }
        }
        None => None,
    };
    e.font_size = e.font_size.map(|n| n.clamp(FONT_SIZE_MIN, FONT_SIZE_MAX));
    e.word_wrap = match e.word_wrap {
        Some(w) => {
            let w = w.trim();
            if w.is_empty() {
                None
            } else if WORD_WRAP_MODES.contains(&w) {
                Some(w.to_owned())
            } else {
                return Err(invalid(
                    "Unknown wordWrap (use off, on, wordWrapColumn, or bounded)",
                ));
            }
        }
        None => None,
    };
    e.word_wrap_column = e.word_wrap_column.map(|n| n.clamp(WRAP_COLUMN_MIN, WRAP_COLUMN_MAX));
    e.tab_size = e.tab_size.map(|n| n.clamp(TAB_SIZE_MIN, TAB_SIZE_MAX));
    e.auto_save = match e.auto_save {
        Some(a) => {
            let a = a.trim();
            if a.is_empty() {
                None
            } else if AUTO_SAVE_MODES.contains(&a) {
                Some(a.to_owned())
            } else {
                return Err(invalid(
                    "Unknown autoSave (use off, afterDelay, onFocusChange, or onWindowChange)",
                ));
            }
        }
        None => None,
    };
    e.auto_save_delay = e
        .auto_save_delay
        .map(|n| n.clamp(AUTO_SAVE_DELAY_MIN, AUTO_SAVE_DELAY_MAX));
    Ok(e)
}

/// Merge the modelled fields into the `editor` object, preserving any sub-keys we
/// don't model. A `None` field removes its key (so a reset-to-default leaves no
/// stale override and the write stays idempotent).
fn apply_editor(obj: &mut Map<String, Value>, e: &EditorSettings) {
    set_or_remove(obj, "fontFamily", e.font_family.clone().map(Value::String));
    set_or_remove(obj, "fontSize", e.font_size.map(|n| Value::Number(n.into())));
    set_or_remove(obj, "fontLigatures", e.font_ligatures.map(Value::Bool));
    set_or_remove(obj, "wordWrap", e.word_wrap.clone().map(Value::String));
    set_or_remove(obj, "wordWrapColumn", e.word_wrap_column.map(|n| Value::Number(n.into())));
    set_or_remove(obj, "tabSize", e.tab_size.map(|n| Value::Number(n.into())));
    set_or_remove(obj, "insertSpaces", e.insert_spaces.map(Value::Bool));
    set_or_remove(obj, "minimap", e.minimap.map(Value::Bool));
    set_or_remove(obj, "formatOnSave", e.format_on_save.map(Value::Bool));
    set_or_remove(obj, "formatOnPaste", e.format_on_paste.map(Value::Bool));
    set_or_remove(
        obj,
        "trimTrailingWhitespace",
        e.trim_trailing_whitespace.map(Value::Bool),
    );
    set_or_remove(obj, "insertFinalNewline", e.insert_final_newline.map(Value::Bool));
    set_or_remove(obj, "trimFinalNewlines", e.trim_final_newlines.map(Value::Bool));
    set_or_remove(obj, "autoSave", e.auto_save.clone().map(Value::String));
    set_or_remove(obj, "autoSaveDelay", e.auto_save_delay.map(|n| Value::Number(n.into())));
}

fn set_or_remove(obj: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(v) => {
            obj.insert(key.into(), v);
        }
        None => {
            obj.remove(key);
        }
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

    /// A fresh, unique temp config dir (we created it, so cleaning it up is safe).
    fn temp_dir() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let mut p = std::env::temp_dir();
        p.push(format!(
            "claude-ide-settings-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn read_reports_empty_when_missing() {
        let dir = temp_dir();
        let got = read(&dir).unwrap();
        assert!(got.user.editor.font_size.is_none());
        assert!(got.workspaces.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_then_read_round_trips_both_scopes() {
        let dir = temp_dir();
        write(
            &dir,
            Scope::User,
            EditorSettings { font_size: Some(15), minimap: Some(false), ..Default::default() },
        )
        .unwrap();
        write(
            &dir,
            Scope::Workspace("/home/me/proj".into()),
            EditorSettings { tab_size: Some(4), ..Default::default() },
        )
        .unwrap();

        let got = read(&dir).unwrap();
        assert_eq!(got.user.editor.font_size, Some(15));
        assert_eq!(got.user.editor.minimap, Some(false));
        assert_eq!(
            got.workspaces.get("/home/me/proj").unwrap().editor.tab_size,
            Some(4)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_clamps_numbers_and_validates_enum() {
        let dir = temp_dir();
        write(
            &dir,
            Scope::User,
            EditorSettings { font_size: Some(9999), tab_size: Some(0), ..Default::default() },
        )
        .unwrap();
        let got = read(&dir).unwrap();
        assert_eq!(got.user.editor.font_size, Some(FONT_SIZE_MAX));
        assert_eq!(got.user.editor.tab_size, Some(TAB_SIZE_MIN));

        let bad = write(
            &dir,
            Scope::User,
            EditorSettings { word_wrap: Some("yolo".into()), ..Default::default() },
        );
        assert!(matches!(bad.unwrap_err().kind, IpcErrorKind::InvalidInput));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_preserves_unknown_keys() {
        let dir = temp_dir();
        std::fs::write(
            settings_path(&dir),
            r#"{ "user": { "editor": { "fontSize": 13, "unknownKey": 1 }, "futureCategory": true }, "topLevelExtra": 5 }"#,
        )
        .unwrap();

        // The frontend writes the full modelled editor block per scope, so we
        // re-send the value we want kept (fontSize) alongside the new one.
        write(
            &dir,
            Scope::User,
            EditorSettings { font_size: Some(13), minimap: Some(true), ..Default::default() },
        )
        .unwrap();

        let raw = std::fs::read_to_string(settings_path(&dir)).unwrap();
        let v: Value = serde_json::from_str(&raw).unwrap();
        // Unmodelled keys (top-level, scope-level, editor-level) all survive a
        // write — we never clobber a newer version's or a hand-edited key.
        assert_eq!(v["topLevelExtra"], 5);
        assert_eq!(v["user"]["futureCategory"], true);
        assert_eq!(v["user"]["editor"]["unknownKey"], 1);
        // Modelled values round-trip.
        assert_eq!(v["user"]["editor"]["fontSize"], 13);
        assert_eq!(v["user"]["editor"]["minimap"], true);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_refuses_non_object_file() {
        let dir = temp_dir();
        std::fs::write(settings_path(&dir), "[1, 2, 3]").unwrap();
        let err = write(&dir, Scope::User, EditorSettings::default()).unwrap_err();
        assert!(matches!(err.kind, IpcErrorKind::InvalidInput));
        // The malformed file is left exactly as it was (never clobbered).
        assert_eq!(std::fs::read_to_string(settings_path(&dir)).unwrap(), "[1, 2, 3]");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_validates_auto_save_and_clamps_delay() {
        let dir = temp_dir();
        write(
            &dir,
            Scope::User,
            EditorSettings {
                auto_save: Some("afterDelay".into()),
                auto_save_delay: Some(1),
                ..Default::default()
            },
        )
        .unwrap();
        let got = read(&dir).unwrap();
        assert_eq!(got.user.editor.auto_save.as_deref(), Some("afterDelay"));
        assert_eq!(got.user.editor.auto_save_delay, Some(AUTO_SAVE_DELAY_MIN));

        let bad = write(
            &dir,
            Scope::User,
            EditorSettings { auto_save: Some("sometimes".into()), ..Default::default() },
        );
        assert!(matches!(bad.unwrap_err().kind, IpcErrorKind::InvalidInput));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_round_trips_data_safety_flags() {
        let dir = temp_dir();
        write(
            &dir,
            Scope::User,
            EditorSettings {
                format_on_save: Some(true),
                trim_trailing_whitespace: Some(false),
                insert_final_newline: Some(true),
                trim_final_newlines: Some(false),
                ..Default::default()
            },
        )
        .unwrap();
        let got = read(&dir).unwrap();
        assert_eq!(got.user.editor.format_on_save, Some(true));
        assert_eq!(got.user.editor.trim_trailing_whitespace, Some(false));
        assert_eq!(got.user.editor.insert_final_newline, Some(true));
        assert_eq!(got.user.editor.trim_final_newlines, Some(false));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reset_to_none_removes_the_key() {
        let dir = temp_dir();
        write(
            &dir,
            Scope::User,
            EditorSettings { font_size: Some(20), ..Default::default() },
        )
        .unwrap();
        // Writing the scope again with the field cleared drops the stored key.
        write(&dir, Scope::User, EditorSettings::default()).unwrap();
        let raw = std::fs::read_to_string(settings_path(&dir)).unwrap();
        let v: Value = serde_json::from_str(&raw).unwrap();
        assert!(v["user"]["editor"].get("fontSize").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
