//! Read-only checkpoint timeline (Phase 7 P2, spec 5.P2 / 1.4.5).
//!
//! The installed CLI exposes **no programmatic rewind/restore** (no flag,
//! subcommand, slash command, or advertised control-protocol capability —
//! verified 2026-06-26). Rewind is a TUI-only feature a stream-json wrapper
//! can't drive, and hand-rolling restore is forbidden (wrapper rule). But the
//! CLI's per-session **file history is fully readable**: snapshots live at
//! `~/.claude/file-history/<session-id>/<hash>@v<N>`, where
//! `hash = hex(sha256(absolute_path))[..16]` (verified) and `@v<N>` are
//! successive versions (each the raw file content at that point).
//!
//! So we present a **read-only** timeline of what the agent changed and a
//! snapshot-vs-current diff preview — a faithful "what would a rewind here
//! restore" view, without performing the (unavailable, unsanctioned) restore.
//! We only ever READ `~/.claude/file-history`; we never modify it.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::{IpcError, IpcErrorKind, IpcResult};

/// Cap on snapshot/current text read for a diff (matches the editor's file cap).
const MAX_DIFF_BYTES: u64 = 2 * 1024 * 1024;
/// Cap on timeline entries returned (newest first); a session rarely exceeds it.
const MAX_ENTRIES: usize = 1000;

/// One checkpoint: a single saved version of one file the agent edited.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointEntry {
    /// Stable key `<hash>@v<N>` (unique within the session).
    pub id: String,
    /// Workspace-relative path, forward-slashed, for display + the diff lookup.
    pub path: String,
    /// The `@v<N>` version number.
    pub version: u32,
    /// The tool that produced it (Write / Edit / …), from the transcript.
    pub tool: String,
    /// Snapshot mtime (ms since epoch) — the timeline's chronological order.
    pub timestamp_ms: u64,
}

/// A session's checkpoint timeline, newest first.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointTimeline {
    pub entries: Vec<CheckpointEntry>,
}

/// A snapshot-vs-current preview for one checkpoint (read-only; no restore).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointDiff {
    pub path: String,
    /// File content at the chosen version.
    pub snapshot: String,
    /// The current on-disk content ("" if the file no longer exists).
    pub current: String,
    /// Either side is binary / too large to show as text.
    pub binary: bool,
}

/// `hex(sha256(absolute_path))[..16]` — the CLI's file-history snapshot key for
/// a path. Pure; locked by a golden test against the real observed value.
fn path_hash(abs_path: &str) -> String {
    let digest = Sha256::digest(abs_path.as_bytes());
    let mut s = String::with_capacity(16);
    for b in &digest[..8] {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Split a snapshot filename `<hash>@v<N>` into its hash and version.
fn parse_snapshot_name(name: &str) -> Option<(String, u32)> {
    let (hash, ver) = name.split_once("@v")?;
    if hash.len() != 16 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some((hash.to_string(), ver.parse().ok()?))
}

/// Extract `{absolute file_path -> tool name}` for every file-editing tool call
/// in a transcript. Pure (takes lines), so it is golden-tested. A cheap
/// substring pre-filter keeps this bounded even on a multi-MB transcript: only
/// lines that look like a relevant `tool_use` are JSON-parsed.
fn collect_edited_paths<I: IntoIterator<Item = String>>(lines: I) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in lines {
        if !line.contains("\"tool_use\"") {
            continue;
        }
        let v: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let blocks = match v.get("message").and_then(|m| m.get("content")).and_then(Value::as_array)
        {
            Some(b) => b,
            None => continue,
        };
        for b in blocks {
            if b.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let tool = b.get("name").and_then(Value::as_str).unwrap_or("");
            let key = match tool {
                "Write" | "Edit" | "MultiEdit" => "file_path",
                "NotebookEdit" => "notebook_path",
                _ => continue,
            };
            if let Some(p) = b.get("input").and_then(|i| i.get(key)).and_then(Value::as_str) {
                // Last tool wins, so the most recent action on a path labels it.
                map.insert(p.to_string(), tool.to_string());
            }
        }
    }
    map
}

/// Build a session's checkpoint timeline by pairing the on-disk file-history
/// snapshots with the file paths recorded in the transcript. Read-only; an
/// unknown session or a session with no edits yields an empty timeline.
pub fn timeline(cwd: Option<String>, session_id: &str) -> IpcResult<CheckpointTimeline> {
    crate::sessions::validate_session_id(session_id)?;
    let cwd_abs = canonical_cwd(cwd)?;

    let history_dir = match crate::sessions::home_dir() {
        Some(h) => h.join(".claude").join("file-history").join(session_id),
        None => return Ok(CheckpointTimeline { entries: Vec::new() }),
    };
    if !history_dir.is_dir() {
        return Ok(CheckpointTimeline { entries: Vec::new() });
    }

    // hash -> (workspace-relative path, tool) for the files this session edited
    // *inside* the workspace (out-of-root edits, e.g. memory files, are skipped).
    let edits = transcript_edits(&cwd_abs, session_id);
    let mut by_hash: HashMap<String, (String, String)> = HashMap::new();
    for (abs, tool) in &edits {
        if let Ok(rel) = Path::new(abs).strip_prefix(&cwd_abs) {
            let rel = rel.to_string_lossy().replace('\\', "/");
            by_hash.insert(path_hash(abs), (rel, tool.clone()));
        }
    }

    let mut entries: Vec<CheckpointEntry> = Vec::new();
    for entry in fs::read_dir(&history_dir).map_err(|e| internal(format!("file-history: {e}")))? {
        let path = match entry {
            Ok(e) => e.path(),
            Err(_) => continue,
        };
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n,
            None => continue,
        };
        let (hash, version) = match parse_snapshot_name(name) {
            Some(t) => t,
            None => continue,
        };
        if let Some((rel, tool)) = by_hash.get(&hash) {
            entries.push(CheckpointEntry {
                id: format!("{hash}@v{version}"),
                path: rel.clone(),
                version,
                tool: tool.clone(),
                timestamp_ms: mtime_ms(&path),
            });
        }
    }

    // Newest first; version breaks ties when two snapshots share an mtime.
    entries.sort_by(|a, b| {
        b.timestamp_ms.cmp(&a.timestamp_ms).then(b.version.cmp(&a.version))
    });
    entries.truncate(MAX_ENTRIES);
    Ok(CheckpointTimeline { entries })
}

/// Snapshot-vs-current preview for one checkpoint. `path` is the workspace-
/// relative path from a timeline entry; `version` its `@v<N>`. Read-only.
pub fn diff(
    cwd: Option<String>,
    session_id: &str,
    path: &str,
    version: u32,
) -> IpcResult<CheckpointDiff> {
    crate::sessions::validate_session_id(session_id)?;
    let cwd_abs = canonical_cwd(cwd.clone())?;

    // Reconstruct the absolute path the CLI hashed (root + the relative suffix)
    // and locate that version's snapshot. The hash is computed by us from a
    // validated session id + the joined path, so the filename can't be injected.
    let abs = cwd_abs.join(path);
    if !abs.starts_with(&cwd_abs) {
        return Err(IpcError::new(IpcErrorKind::InvalidInput, "Path escapes the workspace"));
    }
    let hash = path_hash(&abs.to_string_lossy());
    let snap_path = crate::sessions::home_dir()
        .ok_or_else(|| internal("no home dir".into()))?
        .join(".claude")
        .join("file-history")
        .join(session_id)
        .join(format!("{hash}@v{version}"));
    if !snap_path.is_file() {
        return Err(IpcError::new(IpcErrorKind::InvalidInput, "That checkpoint was not found"));
    }
    let (snapshot, snap_binary) = read_capped(&snap_path);

    // The current side reuses the editor's root-confined, binary-guarded reader;
    // a missing file (the agent deleted it) shows as an empty current side.
    let (current, cur_binary) = match crate::files::read_file(cwd, path.to_string()) {
        Ok(fc) => (fc.text, fc.binary),
        Err(_) => (String::new(), false),
    };

    Ok(CheckpointDiff {
        path: path.to_string(),
        snapshot,
        current,
        binary: snap_binary || cur_binary,
    })
}

/// Read the transcript for `session_id` and return `(absolute_path, tool)` for
/// each file-editing tool call. Empty if the transcript can't be located.
fn transcript_edits(cwd_abs: &Path, session_id: &str) -> HashMap<String, String> {
    let projects = match crate::sessions::claude_projects_dir() {
        Some(p) => p,
        None => return HashMap::new(),
    };
    let dir = match crate::sessions::resolve_project_dir(&projects, cwd_abs) {
        Some(d) => d,
        None => return HashMap::new(),
    };
    let path = dir.join(format!("{session_id}.jsonl"));
    let file = match fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => return HashMap::new(),
    };
    let lines = BufReader::new(file).lines().map_while(Result::ok);
    collect_edited_paths(lines)
}

/// Read up to the diff cap; report binary (a NUL byte) rather than showing junk.
fn read_capped(path: &Path) -> (String, bool) {
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (String::new(), false),
    };
    let mut buf = Vec::new();
    if file.take(MAX_DIFF_BYTES).read_to_end(&mut buf).is_err() {
        return (String::new(), false);
    }
    if buf.contains(&0) {
        return (String::new(), true);
    }
    (String::from_utf8_lossy(&buf).into_owned(), false)
}

fn canonical_cwd(cwd: Option<String>) -> IpcResult<PathBuf> {
    let target = crate::workspace::resolve_cwd(cwd)?;
    Ok(fs::canonicalize(&target).unwrap_or(target))
}

fn mtime_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn internal(message: String) -> IpcError {
    IpcError::new(IpcErrorKind::Internal, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_hash_matches_observed_cli_value() {
        // The real snapshot for this path was named `7f5d8f548efb3025@v2`.
        let p = "/home/saud/.claude/projects/-home-saud-Desktop-claude-ide/memory/MEMORY.md";
        assert_eq!(path_hash(p), "7f5d8f548efb3025");
    }

    #[test]
    fn parses_snapshot_names() {
        assert_eq!(parse_snapshot_name("0c1849dde5ac7be7@v6"), Some(("0c1849dde5ac7be7".into(), 6)));
        assert_eq!(parse_snapshot_name("0378ea30608e9d6a@v2"), Some(("0378ea30608e9d6a".into(), 2)));
        assert_eq!(parse_snapshot_name("notahash@v2"), None); // wrong length
        assert_eq!(parse_snapshot_name("0c1849dde5ac7be7"), None); // no version
        assert_eq!(parse_snapshot_name("zzzzzzzzzzzzzzzz@v2"), None); // not hex
    }

    #[test]
    fn collects_only_file_editing_tools() {
        let lines = vec![
            // a Read is not an edit -> ignored
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/p/a.rs"}}]}}"#.to_string(),
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Write","input":{"file_path":"/p/b.rs","content":"x"}}]}}"#.to_string(),
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t3","name":"Edit","input":{"file_path":"/p/b.rs"}}]}}"#.to_string(),
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t4","name":"NotebookEdit","input":{"notebook_path":"/p/n.ipynb"}}]}}"#.to_string(),
            "not json".to_string(),
        ];
        let map = collect_edited_paths(lines);
        assert_eq!(map.len(), 2);
        assert_eq!(map.get("/p/b.rs").map(String::as_str), Some("Edit")); // last tool wins
        assert_eq!(map.get("/p/n.ipynb").map(String::as_str), Some("NotebookEdit"));
        assert!(!map.contains_key("/p/a.rs"));
    }
}
