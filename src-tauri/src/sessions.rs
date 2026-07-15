//! Sessions rail backend (spec 3.2, 3.3 "List sessions").
//!
//! Lists the `claude` sessions for a workspace by reading the CLI's own
//! `~/.claude/projects/<slug>/<uuid>.jsonl` transcripts — **read-only**, and only
//! each file's head + tail (never the whole transcript; large/active sessions
//! must stay cheap, per the cross-session-search rule). The workspace's project
//! dir is found by matching the `cwd` field *inside* the transcripts, never by
//! recomputing the slug (spec 3.2: long paths may be truncated/hashed).
//!
//! A `notify` watcher on `~/.claude/projects/` fires when the CLI creates a new
//! `<uuid>.jsonl`, so a fresh session appears in the rail live (spec 3.2 / 1.4.5)
//! with no polling. Only create/remove events drive a refresh — modify events
//! (an active transcript being appended) are ignored so a live session doesn't
//! cause churn.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::Value;
use tauri::ipc::Channel;

use crate::error::{IpcError, IpcErrorKind, IpcResult};

/// One session as shown in the rail. Built from the transcript's head + tail
/// only — never the full file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    /// The `<uuid>` filename stem — i.e. the session id used to `--resume`.
    pub id: String,
    /// Human label: best of ai-title → last prompt → first user message → id.
    pub label: String,
    /// Git branch the session ran on, if recorded.
    pub git_branch: Option<String>,
    /// File mtime (ms since epoch) — used to sort by most-recent activity.
    pub last_active_ms: u64,
}

/// A project dir whose sessions were recorded at a now-missing path that shares
/// this workspace's folder name — i.e. the folder was moved or renamed. Surfaced
/// so the rail can offer a one-time restore (copy) into the new location.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MovedProject {
    /// The cwd recorded inside those transcripts (no longer present on disk).
    pub old_cwd: String,
    /// The `~/.claude/projects/` dir name holding them — used only to name the
    /// restore source; validated as a single path component server-side.
    pub slug: String,
    /// Sessions here that are not yet present at the current location.
    pub session_count: usize,
    /// Newest activity across those sessions (ms since epoch).
    pub last_active_ms: u64,
}

/// One rendered conversation item from a past transcript. Serializes to exactly
/// the frontend's `ConvItem` shape (`store/conversation.ts`) so a resumed
/// session's history renders through the same pane as live turns. Tagged by
/// `kind` (not `type`) to match that union.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ConvItem {
    User {
        id: String,
        text: String,
    },
    Assistant {
        id: String,
        text: String,
    },
    Tool {
        id: String,
        name: String,
        input: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        output: Option<Value>,
        #[serde(rename = "isError")]
        is_error: bool,
        status: &'static str,
    },
}

/// A resumed session's full conversation history. `truncated` is set when the
/// transcript was longer than the render cap and only the most-recent items are
/// returned (virtualized full history is a later refinement).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTranscript {
    pub items: Vec<ConvItem>,
    pub truncated: bool,
}

/// Cap on items returned for a resumed session; the most-recent are kept.
const MAX_TRANSCRIPT_ITEMS: usize = 2000;

/// Owns the workspace's session FsWatcher (kept alive here; dropping it stops
/// watching). Managed by Tauri as `Arc<SessionsRegistry>`.
#[derive(Default)]
pub struct SessionsRegistry {
    watcher: Mutex<Option<RecommendedWatcher>>,
}

impl SessionsRegistry {
    /// Watch `~/.claude/projects/` for new/removed sessions; on a (coalesced)
    /// change, recompute the workspace's session list and push it over
    /// `on_change`. Replaces any prior watcher.
    pub fn watch(&self, cwd: Option<String>, on_change: Channel<Vec<SessionMeta>>) -> IpcResult<()> {
        let projects = claude_projects_dir();

        let (tx, rx) = mpsc::channel::<()>();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                // Only a new or removed session changes the list; appends to an
                // active transcript (Modify) are ignored to avoid churn.
                if matches!(event.kind, EventKind::Create(_) | EventKind::Remove(_)) {
                    let _ = tx.send(());
                }
            }
        })
        .map_err(|e| internal(format!("Could not start a session watcher: {e}")))?;

        if let Some(ref dir) = projects {
            watcher
                .watch(dir, RecursiveMode::Recursive)
                .map_err(|e| internal(format!("Could not watch the projects directory: {e}")))?;
        }

        // Coalescing thread: after a burst, wait for ~300ms of quiet, then
        // recompute once. Exits when the watcher (and its `tx`) is dropped.
        std::thread::Builder::new()
            .name("sessions-watch".into())
            .spawn(move || {
                while rx.recv().is_ok() {
                    while rx.recv_timeout(Duration::from_millis(300)).is_ok() {}
                    if let Ok(list) = list(cwd.clone()) {
                        if on_change.send(list).is_err() {
                            break; // frontend went away
                        }
                    }
                }
            })
            .map_err(|e| internal(format!("Could not start the session watch thread: {e}")))?;

        *self.watcher.lock().unwrap_or_else(|e| e.into_inner()) = Some(watcher);
        Ok(())
    }

    /// Stop watching (drops the watcher → its thread exits) on app exit.
    pub fn shutdown_all(&self) {
        *self.watcher.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// List the workspace's sessions, newest activity first. An unknown / never-run
/// directory has no project dir yet → an empty list is the correct state.
pub fn list(cwd: Option<String>) -> IpcResult<Vec<SessionMeta>> {
    let target = crate::workspace::resolve_cwd(cwd)?;
    let projects = match claude_projects_dir() {
        Some(p) => p,
        None => return Ok(Vec::new()),
    };
    let dir = match resolve_project_dir(&projects, &target) {
        Some(d) => d,
        None => return Ok(Vec::new()),
    };

    let mut out = Vec::new();
    let entries =
        fs::read_dir(&dir).map_err(|e| internal(format!("Could not read the project dir: {e}")))?;
    for entry in entries {
        let path = match entry {
            Ok(e) => e.path(),
            Err(_) => continue,
        };
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let head = read_head_lines(&path, 80);
        let tail = read_tail_lines(&path, 32 * 1024, 40);
        let mut probe = Probe::default();
        probe_lines(&head, &mut probe);
        probe_lines(&tail, &mut probe);
        out.push(SessionMeta {
            label: build_label(&probe, &id),
            git_branch: probe.git_branch.clone(),
            last_active_ms: mtime_ms(&path),
            id,
        });
    }
    out.sort_by_key(|s| std::cmp::Reverse(s.last_active_ms));
    Ok(out)
}

// ----- full transcript -> renderable history (spec 3.3 "resume") -------------

/// Validate a session id used both as a `--resume` argument and as a
/// `<id>.jsonl` filename. Rejects anything that isn't a plain id token so it can
/// never escape the project dir or smuggle in a flag.
pub(crate) fn validate_session_id(id: &str) -> IpcResult<()> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if ok {
        Ok(())
    } else {
        Err(IpcError::new(IpcErrorKind::InvalidInput, "Invalid session id"))
    }
}

/// Read a past session's full transcript into renderable conversation items, so
/// a resumed session shows its history (the live `--resume` stream does not
/// replay prior turns — verified against the installed CLI).
pub fn read_transcript(cwd: Option<String>, session_id: &str) -> IpcResult<SessionTranscript> {
    validate_session_id(session_id)?;
    let target = crate::workspace::resolve_cwd(cwd)?;
    let projects = claude_projects_dir()
        .ok_or_else(|| IpcError::new(IpcErrorKind::InvalidInput, "No Claude sessions on disk"))?;
    let dir = resolve_project_dir(&projects, &target).ok_or_else(|| {
        IpcError::new(IpcErrorKind::InvalidInput, "This workspace has no Claude sessions yet")
    })?;
    let path = dir.join(format!("{session_id}.jsonl"));
    if !path.is_file() {
        return Err(IpcError::new(IpcErrorKind::InvalidInput, "That session was not found"));
    }
    let file = fs::File::open(&path)
        .map_err(|e| internal(format!("Could not open the session transcript: {e}")))?;
    let lines = BufReader::new(file).lines().map_while(Result::ok);
    Ok(parse_transcript(lines))
}

/// Fold transcript lines into ordered conversation items. Pure (no IO) so it is
/// golden-tested below. User/assistant text become bubbles; `tool_use` becomes a
/// card whose output is filled in by the matching `tool_result`; `thinking`,
/// meta and sidechain records are skipped (parity with the live pane).
fn parse_transcript<I: IntoIterator<Item = String>>(lines: I) -> SessionTranscript {
    let mut items: Vec<ConvItem> = Vec::new();
    let mut tool_index: HashMap<String, usize> = HashMap::new();
    let mut seq: u64 = 0;

    for line in lines {
        let v: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // System reminders, command echoes (`isMeta`) and sub-agent threads
        // (`isSidechain`) are not part of the visible conversation.
        if v.get("isMeta").and_then(Value::as_bool) == Some(true)
            || v.get("isSidechain").and_then(Value::as_bool) == Some(true)
        {
            continue;
        }
        let uuid = v.get("uuid").and_then(Value::as_str);
        match v.get("type").and_then(Value::as_str).unwrap_or("") {
            "user" => append_user(&v, &mut items, &tool_index, uuid, &mut seq),
            "assistant" => append_assistant(&v, &mut items, &mut tool_index, uuid, &mut seq),
            _ => {}
        }
    }

    let truncated = items.len() > MAX_TRANSCRIPT_ITEMS;
    if truncated {
        let drop = items.len() - MAX_TRANSCRIPT_ITEMS;
        items.drain(0..drop);
    }
    SessionTranscript { items, truncated }
}

/// A `user` record: text blocks (or a string body) become a user bubble;
/// `tool_result` blocks fill the output of the matching earlier tool card.
fn append_user(
    v: &Value,
    items: &mut Vec<ConvItem>,
    tool_index: &HashMap<String, usize>,
    uuid: Option<&str>,
    seq: &mut u64,
) {
    let content = match v.get("message").and_then(|m| m.get("content")) {
        Some(c) => c,
        None => return,
    };
    match content {
        Value::String(s) => push_text(items, ConvKind::User, s, uuid, seq),
        Value::Array(blocks) => {
            let mut text = String::new();
            for b in blocks {
                match b.get("type").and_then(Value::as_str) {
                    Some("text") => append_block_text(&mut text, b),
                    Some("tool_result") => {
                        if let Some(id) = b.get("tool_use_id").and_then(Value::as_str) {
                            if let Some(&idx) = tool_index.get(id) {
                                if let ConvItem::Tool { output, is_error, status, .. } =
                                    &mut items[idx]
                                {
                                    *output =
                                        Some(b.get("content").cloned().unwrap_or(Value::Null));
                                    *is_error =
                                        b.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                                    *status = "done";
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            push_text(items, ConvKind::User, &text, uuid, seq);
        }
        _ => {}
    }
}

/// An `assistant` record: text blocks become a bubble; each `tool_use` becomes a
/// card. A bubble is flushed before a following tool card so order is preserved.
fn append_assistant(
    v: &Value,
    items: &mut Vec<ConvItem>,
    tool_index: &mut HashMap<String, usize>,
    uuid: Option<&str>,
    seq: &mut u64,
) {
    let blocks = match v.get("message").and_then(|m| m.get("content")).and_then(Value::as_array) {
        Some(b) => b,
        None => return,
    };
    let mut text = String::new();
    for b in blocks {
        match b.get("type").and_then(Value::as_str) {
            Some("text") => append_block_text(&mut text, b),
            Some("tool_use") => {
                push_text(items, ConvKind::Assistant, &text, uuid, seq);
                text.clear();
                let id = b.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                let name =
                    b.get("name").and_then(Value::as_str).unwrap_or("tool").to_string();
                let input = b.get("input").cloned().unwrap_or(Value::Null);
                let key = if id.is_empty() { item_id("t", uuid, seq) } else { id };
                items.push(ConvItem::Tool {
                    id: key.clone(),
                    name,
                    input,
                    output: None,
                    is_error: false,
                    status: "done",
                });
                tool_index.insert(key, items.len() - 1);
            }
            _ => {} // `thinking` and any other block: skipped (parity with live)
        }
    }
    push_text(items, ConvKind::Assistant, &text, uuid, seq);
}

enum ConvKind {
    User,
    Assistant,
}

/// Append a text block's `text` to the running buffer, newline-separated.
fn append_block_text(buf: &mut String, block: &Value) {
    if let Some(t) = block.get("text").and_then(Value::as_str) {
        if !buf.is_empty() {
            buf.push('\n');
        }
        buf.push_str(t);
    }
}

/// Push a user/assistant bubble for `text` if it is non-empty (trimmed).
fn push_text(items: &mut Vec<ConvItem>, kind: ConvKind, text: &str, uuid: Option<&str>, seq: &mut u64) {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return;
    }
    let text = trimmed.to_string();
    items.push(match kind {
        ConvKind::User => ConvItem::User { id: item_id("u", uuid, seq), text },
        ConvKind::Assistant => ConvItem::Assistant { id: item_id("a", uuid, seq), text },
    });
}

/// A stable, unique React key: `h-<kind>-<uuid>-<n>` (counter guarantees
/// uniqueness when one record yields several bubbles or omits its uuid).
fn item_id(kind: &str, uuid: Option<&str>, seq: &mut u64) -> String {
    let n = *seq;
    *seq += 1;
    match uuid {
        Some(u) => format!("h-{kind}-{u}-{n}"),
        None => format!("h-{kind}-{n}"),
    }
}

// ----- project-dir resolution (match by recorded cwd, never by slug) ---------

pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

pub(crate) fn claude_projects_dir() -> Option<PathBuf> {
    let dir = home_dir()?.join(".claude").join("projects");
    dir.is_dir().then_some(dir)
}

/// Find the project dir whose transcripts record `target` as their cwd. Reads
/// the CLI's own data instead of reversing the lossy slug (spec 3.2). Reused by
/// the checkpoint timeline to locate a session's transcript.
///
/// If no dir records `target` exactly, fall back to a single moved-folder match
/// (see `single_moved_dir`) so a renamed/moved workspace still shows its old
/// sessions. Resuming them still needs an explicit copy (`relink_moved`).
pub(crate) fn resolve_project_dir(projects: &Path, target: &Path) -> Option<PathBuf> {
    let target_canon = fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf());
    resolve_exact(projects, &target_canon).or_else(|| single_moved_dir(projects, &target_canon))
}

/// The dir whose transcripts record `target_canon` as their cwd, exactly. This
/// is the CLI's live location for `target` — always preferred over any bridge.
fn resolve_exact(projects: &Path, target_canon: &Path) -> Option<PathBuf> {
    for entry in fs::read_dir(projects).ok()? {
        let dir = match entry {
            Ok(e) => e.path(),
            Err(_) => continue,
        };
        if !dir.is_dir() {
            continue;
        }
        if let Some(cwd) = dir_recorded_cwd(&dir) {
            let recorded = PathBuf::from(&cwd);
            let recorded_canon = fs::canonicalize(&recorded).unwrap_or(recorded);
            if recorded_canon == *target_canon {
                return Some(dir);
            }
        }
    }
    None
}

/// The single project dir that looks like an earlier location of `target_canon`:
/// same folder name, recorded path now gone, and not `target`'s own canonical
/// slug dir (where a restore copies *into*). Returns `None` if zero or more than
/// one match — an ambiguous same-name orphan is never auto-bridged.
fn single_moved_dir(projects: &Path, target_canon: &Path) -> Option<PathBuf> {
    let target_base = target_canon.file_name()?;
    let self_slug = claude_slug(target_canon);
    let mut found: Option<PathBuf> = None;
    for entry in fs::read_dir(projects).ok()? {
        let dir = match entry {
            Ok(e) => e.path(),
            Err(_) => continue,
        };
        if !dir.is_dir() {
            continue;
        }
        if dir.file_name().and_then(|n| n.to_str()) == Some(self_slug.as_str()) {
            continue;
        }
        let cwd = match dir_recorded_cwd(&dir) {
            Some(c) => c,
            None => continue,
        };
        let recorded = PathBuf::from(&cwd);
        if recorded.file_name() != Some(target_base) || recorded.exists() {
            continue;
        }
        if found.is_some() {
            return None; // ambiguous → no auto-bridge
        }
        found = Some(dir);
    }
    found
}

/// Mirror the CLI's project-dir naming: the absolute path with every
/// non-alphanumeric byte replaced by `-` (observed: `/home/saud/x` →
/// `-home-saud-x`). ponytail: only used as a fallback when no live project dir
/// exists yet for `target`, so a drifting CLI rule degrades to "restored
/// sessions appear after the next turn", never data loss.
fn claude_slug(path: &Path) -> String {
    path.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// The session ids (transcript filename stems) present in `dir`.
fn session_ids_in(dir: &Path) -> HashSet<String> {
    let mut ids = HashSet::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    ids.insert(stem.to_string());
                }
            }
        }
    }
    ids
}

/// A valid `~/.claude/projects/` dir name: one path component, no separators or
/// traversal. Guards `relink_moved` against a frontend-supplied slug escaping
/// the projects dir.
fn valid_slug_component(slug: &str) -> bool {
    !slug.is_empty()
        && slug != "."
        && slug != ".."
        && !slug.contains('/')
        && !slug.contains('\\')
        && !slug.contains('\0')
}

/// Detect sessions left behind at a previous location of this workspace (folder
/// moved/renamed). Read-only. Counts only sessions not already present here, so
/// the rail's restore prompt clears itself once a restore is complete.
pub fn detect_moved(cwd: Option<String>) -> IpcResult<Vec<MovedProject>> {
    let target = crate::workspace::resolve_cwd(cwd)?;
    let target_canon = fs::canonicalize(&target).unwrap_or_else(|_| target.clone());
    let target_base = match target_canon.file_name() {
        Some(b) => b.to_os_string(),
        None => return Ok(Vec::new()),
    };
    let projects = match claude_projects_dir() {
        Some(p) => p,
        None => return Ok(Vec::new()),
    };
    let self_slug = claude_slug(&target_canon);
    // Sessions already restored to (or native at) the current location are hidden
    // from the prompt so it can't re-offer work that's already done.
    let current_ids = resolve_exact(&projects, &target_canon)
        .map(|d| session_ids_in(&d))
        .unwrap_or_default();

    let mut out = Vec::new();
    let entries =
        fs::read_dir(&projects).map_err(|e| internal(format!("Could not read projects dir: {e}")))?;
    for entry in entries {
        let dir = match entry {
            Ok(e) => e.path(),
            Err(_) => continue,
        };
        if !dir.is_dir() || dir.file_name().and_then(|n| n.to_str()) == Some(self_slug.as_str()) {
            continue;
        }
        let cwd = match dir_recorded_cwd(&dir) {
            Some(c) => c,
            None => continue,
        };
        let recorded = PathBuf::from(&cwd);
        if recorded.file_name() != Some(target_base.as_os_str()) || recorded.exists() {
            continue;
        }
        let mut count = 0usize;
        let mut newest = 0u64;
        if let Ok(files) = fs::read_dir(&dir) {
            for f in files.flatten() {
                let p = f.path();
                if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                let id = match p.file_stem().and_then(|s| s.to_str()) {
                    Some(s) => s,
                    None => continue,
                };
                if current_ids.contains(id) {
                    continue;
                }
                count += 1;
                newest = newest.max(mtime_ms(&p));
            }
        }
        if count == 0 {
            continue;
        }
        let slug = match dir.file_name().and_then(|n| n.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        out.push(MovedProject {
            old_cwd: cwd,
            slug,
            session_count: count,
            last_active_ms: newest,
        });
    }
    out.sort_by_key(|m| std::cmp::Reverse(m.last_active_ms));
    Ok(out)
}

/// Restore a moved project's sessions into this workspace's current location by
/// copying the CLI's own transcripts, so `claude --resume` finds them again.
/// Copy-only: never overwrites a live transcript, never deletes the source (the
/// wrapper removes nothing under `~/.claude`). `slug` must be a dir flagged by
/// `detect_moved` for this cwd — re-verified here, never trusted from the caller.
pub fn relink_moved(cwd: Option<String>, slug: String) -> IpcResult<usize> {
    if !valid_slug_component(&slug) {
        return Err(IpcError::new(IpcErrorKind::InvalidInput, "Invalid session folder"));
    }
    let target = crate::workspace::resolve_cwd(cwd.clone())?;
    if !detect_moved(cwd)?.iter().any(|m| m.slug == slug) {
        return Err(IpcError::new(
            IpcErrorKind::InvalidInput,
            "No moved sessions to restore here",
        ));
    }
    let projects = claude_projects_dir()
        .ok_or_else(|| IpcError::new(IpcErrorKind::InvalidInput, "No Claude sessions on disk"))?;
    let source = projects.join(&slug);
    let target_canon = fs::canonicalize(&target).unwrap_or_else(|_| target.clone());
    // Where the CLI will look at the new location: its live dir if one already
    // exists, else the derived slug dir (created now; the CLI reuses it).
    let dest = resolve_exact(&projects, &target_canon)
        .unwrap_or_else(|| projects.join(claude_slug(&target_canon)));
    fs::create_dir_all(&dest)
        .map_err(|e| internal(format!("Could not create the project dir: {e}")))?;

    // Defense in depth: both endpoints must stay under projects/.
    let proj_canon = fs::canonicalize(&projects).unwrap_or_else(|_| projects.clone());
    for p in [&source, &dest] {
        let c = fs::canonicalize(p).unwrap_or_else(|_| p.clone());
        if !c.starts_with(&proj_canon) {
            return Err(IpcError::new(
                IpcErrorKind::InvalidInput,
                "Path escapes the projects dir",
            ));
        }
    }

    let mut copied = 0usize;
    let entries =
        fs::read_dir(&source).map_err(|e| internal(format!("Could not read the moved project: {e}")))?;
    for entry in entries {
        let sp = match entry {
            Ok(e) => e.path(),
            Err(_) => continue,
        };
        if sp.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let name = match sp.file_name() {
            Some(n) => n,
            None => continue,
        };
        let dp = dest.join(name);
        if dp.exists() {
            continue; // never clobber a live transcript
        }
        fs::copy(&sp, &dp).map_err(|e| internal(format!("Could not copy a session: {e}")))?;
        copied += 1;
    }
    Ok(copied)
}

/// The first non-null `cwd` recorded in any transcript in `dir`.
fn dir_recorded_cwd(dir: &Path) -> Option<String> {
    for entry in fs::read_dir(dir).ok()? {
        let path = match entry {
            Ok(e) => e.path(),
            Err(_) => continue,
        };
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let mut probe = Probe::default();
        probe_lines(&read_head_lines(&path, 80), &mut probe);
        if probe.first_cwd.is_some() {
            return probe.first_cwd;
        }
    }
    None
}

// ----- cheap file reads (head + tail only) -----------------------------------

fn read_head_lines(path: &Path, max_lines: usize) -> Vec<String> {
    match fs::File::open(path) {
        Ok(file) => BufReader::new(file)
            .lines()
            .take(max_lines)
            .filter_map(Result::ok)
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn read_tail_lines(path: &Path, max_bytes: u64, max_lines: usize) -> Vec<String> {
    let mut file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let len = match file.metadata() {
        Ok(m) => m.len(),
        Err(_) => return Vec::new(),
    };
    let start = len.saturating_sub(max_bytes);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<String> = text.split('\n').map(str::to_string).collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0); // drop the (likely partial) first line
    }
    let mut kept: Vec<String> = lines
        .into_iter()
        .filter(|l| !l.trim().is_empty())
        .rev()
        .take(max_lines)
        .collect();
    kept.reverse();
    kept
}

fn mtime_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ----- transcript probing + label (pure; golden-tested below) ----------------

#[derive(Default)]
struct Probe {
    git_branch: Option<String>,
    first_cwd: Option<String>,
    ai_title: Option<String>,
    last_prompt: Option<String>,
    first_user_text: Option<String>,
}

/// Fold a slice of transcript lines into `probe`. First-wins for branch/cwd/
/// first user message; latest-wins for ai-title and last-prompt (call with the
/// head first, then the tail).
fn probe_lines(lines: &[String], probe: &mut Probe) {
    for line in lines {
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if probe.git_branch.is_none() {
            if let Some(b) = nonempty_str(&v, "gitBranch") {
                probe.git_branch = Some(b);
            }
        }
        if probe.first_cwd.is_none() {
            if let Some(c) = nonempty_str(&v, "cwd") {
                probe.first_cwd = Some(c);
            }
        }
        match v.get("type").and_then(Value::as_str).unwrap_or("") {
            "ai-title" => {
                if let Some(t) = nonempty_str(&v, "title") {
                    probe.ai_title = Some(t);
                }
            }
            "last-prompt" => {
                if let Some(p) = nonempty_str(&v, "lastPrompt") {
                    probe.last_prompt = Some(p);
                }
            }
            // First visible user line wins; once set, never overwritten (so the
            // arm is skipped entirely once we have it).
            "user" if probe.first_user_text.is_none() => {
                probe.first_user_text = user_text(&v);
            }
            _ => {}
        }
    }
}

fn nonempty_str(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Pull the text out of a `user` record's `message.content` (string or an array
/// of `{type:"text", text}` blocks).
fn user_text(v: &Value) -> Option<String> {
    let content = v.get("message")?.get("content")?;
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(items) => {
            let mut buf = String::new();
            for item in items {
                if item.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(t) = item.get("text").and_then(Value::as_str) {
                        buf.push_str(t);
                        buf.push(' ');
                    }
                }
            }
            (!buf.trim().is_empty()).then(|| buf.trim().to_string())
        }
        _ => None,
    }
}

fn build_label(probe: &Probe, id: &str) -> String {
    let raw = probe
        .ai_title
        .as_deref()
        .or(probe.last_prompt.as_deref())
        .or(probe.first_user_text.as_deref());
    match raw {
        Some(s) => clean_label(s),
        None => format!("Session {}", &id[..id.len().min(8)]),
    }
}

/// Collapse whitespace to single spaces, trim, and cap length for the rail.
fn clean_label(s: &str) -> String {
    let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
    const MAX: usize = 80;
    if collapsed.chars().count() > MAX {
        let mut t: String = collapsed.chars().take(MAX).collect();
        t.push('…');
        t
    } else {
        collapsed
    }
}

fn internal(message: String) -> IpcError {
    IpcError::new(IpcErrorKind::Internal, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(raw: &[&str]) -> Vec<String> {
        raw.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn claude_slug_replaces_non_alnum() {
        assert_eq!(
            claude_slug(Path::new("/home/saud/Desktop/claude-ide")),
            "-home-saud-Desktop-claude-ide"
        );
    }

    #[test]
    fn valid_slug_component_rejects_traversal() {
        assert!(valid_slug_component("-home-saud-x"));
        assert!(!valid_slug_component(""));
        assert!(!valid_slug_component("."));
        assert!(!valid_slug_component(".."));
        assert!(!valid_slug_component("a/b"));
        assert!(!valid_slug_component("a\\b"));
    }

    #[test]
    fn single_moved_dir_matches_one_same_name_orphan() {
        let base =
            std::env::temp_dir().join(format!("cide-smd-{}-{}", std::process::id(), line!()));
        let _ = fs::remove_dir_all(&base);
        let projects = base.join("projects");
        fs::create_dir_all(&projects).unwrap();
        // New (current) location exists so it canonicalizes; old one is gone.
        let newloc = base.join("new").join("proj");
        fs::create_dir_all(&newloc).unwrap();
        let oldloc = base.join("old").join("proj");
        let old_slug = projects.join("oldslug");
        fs::create_dir_all(&old_slug).unwrap();
        fs::write(
            old_slug.join("s1.jsonl"),
            format!("{{\"cwd\":\"{}\"}}\n", oldloc.display()),
        )
        .unwrap();

        let tc = fs::canonicalize(&newloc).unwrap();
        assert_eq!(
            single_moved_dir(&projects, &tc).as_deref(),
            Some(old_slug.as_path())
        );

        // A second same-name orphan makes it ambiguous → no auto-bridge.
        let old_slug2 = projects.join("oldslug2");
        fs::create_dir_all(&old_slug2).unwrap();
        let oldloc2 = base.join("older").join("proj");
        fs::write(
            old_slug2.join("s2.jsonl"),
            format!("{{\"cwd\":\"{}\"}}\n", oldloc2.display()),
        )
        .unwrap();
        assert!(single_moved_dir(&projects, &tc).is_none());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn ai_title_wins_over_prompt_and_message() {
        let head = lines(&[
            r#"{"type":"user","gitBranch":"main","cwd":"/p","message":{"role":"user","content":[{"type":"text","text":"first message"}]}}"#,
        ]);
        let tail = lines(&[
            r#"{"type":"last-prompt","lastPrompt":"a later prompt"}"#,
            r#"{"type":"ai-title","title":"Wire up the parser"}"#,
        ]);
        let mut p = Probe::default();
        probe_lines(&head, &mut p);
        probe_lines(&tail, &mut p);
        assert_eq!(build_label(&p, "abcd1234-x"), "Wire up the parser");
        assert_eq!(p.git_branch.as_deref(), Some("main"));
        assert_eq!(p.first_cwd.as_deref(), Some("/p"));
    }

    #[test]
    fn falls_back_to_last_prompt_then_first_message() {
        let mut p = Probe::default();
        probe_lines(
            &lines(&[
                r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"do the thing"}]}}"#,
                r#"{"type":"last-prompt","lastPrompt":"the most recent prompt"}"#,
                r#"{"type":"ai-title","title":null}"#,
            ]),
            &mut p,
        );
        assert_eq!(build_label(&p, "id"), "the most recent prompt");

        let mut q = Probe::default();
        probe_lines(
            &lines(&[
                r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"only a message"}]}}"#,
            ]),
            &mut q,
        );
        assert_eq!(build_label(&q, "id"), "only a message");
    }

    #[test]
    fn string_content_and_id_fallback() {
        let mut p = Probe::default();
        probe_lines(
            &lines(&[r#"{"type":"user","message":{"role":"user","content":"plain string body"}}"#]),
            &mut p,
        );
        assert_eq!(build_label(&p, "id"), "plain string body");

        // No title/prompt/message at all -> short-id fallback.
        let mut empty = Probe::default();
        probe_lines(
            &lines(&[r#"{"type":"queue-operation","cwd":null,"gitBranch":null}"#]),
            &mut empty,
        );
        assert_eq!(build_label(&empty, "abcd1234-5678"), "Session abcd1234");
    }

    #[test]
    fn label_collapses_whitespace_and_truncates() {
        assert_eq!(clean_label("  hello\n  world\t! "), "hello world !");
        let long = "x".repeat(200);
        let out = clean_label(&long);
        assert_eq!(out.chars().count(), 81); // 80 + the ellipsis
        assert!(out.ends_with('…'));
    }

    #[test]
    fn malformed_lines_are_skipped() {
        let mut p = Probe::default();
        probe_lines(
            &lines(&[
                "not json at all",
                r#"{"type":"ai-title","title":"survives the junk"}"#,
            ]),
            &mut p,
        );
        assert_eq!(build_label(&p, "id"), "survives the junk");
    }

    #[test]
    fn transcript_renders_user_assistant_and_merged_tools() {
        let raw = lines(&[
            // meta + sidechain records are not part of the visible conversation
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<system-reminder>"}}"#,
            r#"{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"subagent"}]}}"#,
            // a real user turn (string body)
            r#"{"type":"user","uuid":"u1","message":{"role":"user","content":"read the file"}}"#,
            // assistant: thinking (dropped), text, then a tool_use
            r#"{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"Let me look."},{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"a.rs"}}]}}"#,
            // the tool_result fills that card (carried in a user record, no bubble)
            r#"{"type":"user","uuid":"u2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"file body","is_error":false}]}}"#,
            r#"{"type":"assistant","uuid":"a2","message":{"role":"assistant","content":[{"type":"text","text":"Done."}]}}"#,
            // unrelated record types are ignored
            r#"{"type":"ai-title","title":"x"}"#,
        ]);
        let t = parse_transcript(raw);
        assert!(!t.truncated);
        assert_eq!(t.items.len(), 4, "user, assistant text, tool card, assistant text");
        assert!(matches!(&t.items[0], ConvItem::User { text, .. } if text == "read the file"));
        assert!(matches!(&t.items[1], ConvItem::Assistant { text, .. } if text == "Let me look."));
        match &t.items[2] {
            ConvItem::Tool { name, output, is_error, status, .. } => {
                assert_eq!(name, "Read");
                assert_eq!(output.as_ref().and_then(Value::as_str), Some("file body"));
                assert!(!is_error);
                assert_eq!(*status, "done");
            }
            other => panic!("expected a Tool card, got {other:?}"),
        }
        assert!(matches!(&t.items[3], ConvItem::Assistant { text, .. } if text == "Done."));
    }

    #[test]
    fn transcript_caps_to_most_recent_items() {
        let raw: Vec<String> = (0..MAX_TRANSCRIPT_ITEMS + 5)
            .map(|i| format!(r#"{{"type":"user","message":{{"role":"user","content":"m{i}"}}}}"#))
            .collect();
        let t = parse_transcript(raw);
        assert!(t.truncated);
        assert_eq!(t.items.len(), MAX_TRANSCRIPT_ITEMS);
        // oldest dropped; the newest message survives as the last item
        let last = format!("m{}", MAX_TRANSCRIPT_ITEMS + 4);
        assert!(matches!(t.items.last(), Some(ConvItem::User { text, .. }) if text == &last));
    }

    #[test]
    fn session_id_validation_rejects_path_escape() {
        assert!(validate_session_id("9e81602b-8acf-48a2-b03b-769ba6830e2e").is_ok());
        assert!(validate_session_id("../../etc/passwd").is_err());
        assert!(validate_session_id("a/b").is_err());
        assert!(validate_session_id("").is_err());
        assert!(validate_session_id(&"x".repeat(65)).is_err());
    }
}
