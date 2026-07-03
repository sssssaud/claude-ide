//! The engine: the typed event contract, the NDJSON parser, and the persistent
//! `claude` session per workspace (spec 2.3, 2.5, 3.5).
//!
//! A workspace owns one long-lived `claude -p --input-format stream-json
//! --output-format stream-json` child, locked to a working directory. Its stdout
//! is parsed line-by-line into `EngineEvent`s and pushed over a per-workspace
//! `Channel`; turns are written to its stdin; cancellation is a `control_request`
//! interrupt — the session survives, only the in-flight turn ends. The child
//! handle and its stdin live *only* in Rust (spec 2.5): the frontend observes the
//! session purely through events. The `EngineEvent` enum is the binding contract,
//! mirrored 1:1 in `src/ipc/types.ts`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

use crate::error::{IpcError, IpcErrorKind, IpcResult};

/// Token usage for a turn (subset; grows when the real parser provides more).
/// `cache_read_input_tokens`/`cache_creation_input_tokens` dominate true
/// context size on a long-running session (a live probe showed cache-read
/// alone at 39k+ tokens in a near-empty conversation) — `input_tokens` alone
/// badly undercounts how full the context window actually is.
#[derive(Debug, Clone, Serialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
}

/// The typed engine event (spec 2.3), serialized internally-tagged by `type`
/// (snake_case) to match the TS mirror. Variants are added as each phase
/// constructs them; `PermissionRequest` arrives with the review queue (Phase 6).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineEvent {
    Init {
        session_id: String,
        model: String,
        slash_commands: Vec<String>,
        tools: Vec<String>,
    },
    AssistantDelta {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        id: String,
        output: Value,
        is_error: bool,
    },
    Result {
        is_error: bool,
        total_cost_usd: Option<f64>,
        usage: Usage,
        session_id: String,
    },
    /// The CLI is asking permission to run a tool (P1 review queue, spec 3.6).
    /// Raised from a `control_request{subtype:"can_use_tool"}` (not the engine's
    /// own stream). The UI surfaces the approval card and answers via
    /// `approve_permission`, which echoes `request_id` back in a `control_response`.
    /// `input` is the proposed tool input — the basis for the diff/command
    /// preview and the editable "Edit" path.
    PermissionRequest {
        request_id: String,
        tool: String,
        input: Value,
        tool_use_id: String,
    },
    Stopped,
    /// A line that could not be parsed — surfaced, never swallowed (spec 2.3).
    ParseError { raw: String },
    /// A single stream line exceeded the per-line byte cap and was dropped; the
    /// reader resynced at the next newline (DoS guard, hardening B2). The session
    /// continues — only the over-long line is lost. `limit` is the cap in bytes.
    LineTruncated { limit: usize },
    /// A newer-CLI event type we don't model — logged, benign (spec 2.3).
    Unknown { kind: String },
    /// A system/status event whose schema we deliberately haven't modeled yet,
    /// captured RAW instead of discarded (Addendum III §S10, capture-first).
    /// `rate_limit_event` is the target: it's a real top-level NDJSON message
    /// type (confirmed present), but its field schema has never been observed
    /// live, so there is no honest way to build a usage/reset-time UI on top of
    /// it today. Every unrecognized `system/<subtype>` gets the same treatment.
    /// This event carries the FULL original JSON to the frontend's existing
    /// `rawLog` (Output/Logs tab) purely for future inspection — no field is
    /// interpreted or surfaced as a fact anywhere yet.
    RawSystemEvent { kind: String, raw: Value },
}

// ----- Persistent `claude` session per workspace (spec 2.5) -------------------

/// One persistent `claude` session. The child handle and its stdin live only
/// here; the frontend never touches the process (spec 2.5).
struct Workspace {
    /// Write turns + interrupts here. `None` once the session is closing.
    stdin: Mutex<Option<ChildStdin>>,
    /// The child, kept for a clean wait-on-close (no zombies).
    child: Mutex<Option<Child>>,
    /// Set while an interrupt is in flight, so the turn's terminal `result` is
    /// translated into a clean `Stopped` for the UI rather than an error.
    interrupting: Arc<AtomicBool>,
    /// Monotonic id source for interrupt control requests.
    next_request: AtomicU64,
}

/// Owns every open workspace's engine session (spec 2.5). Managed by Tauri as
/// `Arc<WorkspaceRegistry>`; teardown reaps all children on app exit.
#[derive(Default)]
pub struct WorkspaceRegistry {
    next_id: AtomicU64,
    workspaces: Mutex<HashMap<String, Arc<Workspace>>>,
}

impl WorkspaceRegistry {
    /// Spawn a persistent `claude` session in `cwd` (defaults to the launch
    /// directory; the folder picker is Phase 4), stream its events over
    /// `channel`, and return the new workspace id.
    pub async fn open(
        &self,
        cwd: Option<String>,
        model: Option<String>,
        effort: Option<String>,
        channel: Channel<EngineEvent>,
    ) -> IpcResult<String> {
        self.open_with(cwd, None, false, model, effort, channel).await
    }

    /// Spawn a session, optionally resuming an existing conversation by id
    /// (`--resume`) or forking it into a new branch (`--fork-session`, only with
    /// resume). The resumed model carries full prior context, but the stream does
    /// **not** replay past turns (verified against the installed CLI) — the UI
    /// renders that history from the transcript separately (`read_session`).
    pub async fn open_with(
        &self,
        cwd: Option<String>,
        resume: Option<String>,
        fork: bool,
        model: Option<String>,
        effort: Option<String>,
        channel: Channel<EngineEvent>,
    ) -> IpcResult<String> {
        let cwd = resolve_cwd(cwd)?;
        let claude = crate::claude_bin::path()?;
        // `--model` takes an alias ("opus"/"sonnet"/"haiku"/"fable") or a full
        // `claude-*` id (verified via `claude --help`). Validate defensively —
        // it's passed as a distinct argv value (no shell), but we still reject
        // anything outside that shape so a bad value can't reach the CLI.
        let model = validate_model(model)?;
        // `--effort` takes one of a fixed set of levels (verified via `--help`).
        let effort = validate_effort(effort)?;

        let mut args: Vec<String> = [
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--include-partial-messages",
            "--verbose",
            "--strict-mcp-config",
            // Route permission decisions over the stdio control protocol (P1,
            // spec 3.6). The `stdio` sentinel makes the CLI emit a
            // `control_request{subtype:"can_use_tool"}` for any tool a static
            // rule doesn't settle; we answer with a `control_response` carrying
            // allow/deny (+ optional edited input). Verified against 2.1.191 —
            // without this flag the CLI auto-denies headlessly. Read-only tools
            // never prompt, so this adds no overhead to a read-only turn.
            "--permission-prompt-tool",
            "stdio",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        if let Some(ref id) = resume {
            crate::sessions::validate_session_id(id)?;
            args.push("--resume".to_string());
            args.push(id.clone());
            if fork {
                args.push("--fork-session".to_string());
            }
        }
        if let Some(m) = model {
            args.push("--model".to_string());
            args.push(m);
        }
        if let Some(e) = effort {
            args.push("--effort".to_string());
            args.push(e);
        }

        let mut child = Command::new(claude)
            .args(&args)
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                IpcError::new(
                    IpcErrorKind::Internal,
                    format!("Failed to start the Claude session: {e}"),
                )
            })?;

        let stdin = child.stdin.take().expect("stdin was piped");
        let stdout = child.stdout.take().expect("stdout was piped");
        let stderr = child.stderr.take().expect("stderr was piped");

        let id = format!("ws-{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        let interrupting = Arc::new(AtomicBool::new(false));

        // Reader: stdout -> bounded line reader -> parse_events -> channel.
        // Interrupt-aware — a `result` arriving while an interrupt is pending
        // becomes a clean `Stopped`. The bounded reader caps per-line memory so a
        // stream that never emits a newline can't balloon the process (B2).
        let reader_flag = interrupting.clone();
        let reader_id = id.clone();
        tauri::async_runtime::spawn(async move {
            read_bounded_lines(stdout, |unit| match unit {
                LineEvent::Line(line) => {
                    for ev in parse_events(line) {
                        let ev = match ev {
                            EngineEvent::Result { .. }
                                if reader_flag.swap(false, Ordering::SeqCst) =>
                            {
                                EngineEvent::Stopped
                            }
                            other => other,
                        };
                        let _ = channel.send(ev);
                    }
                }
                LineEvent::Truncated { limit } => {
                    tracing::warn!(workspace = %reader_id, limit, "engine stream line exceeded cap; dropped");
                    let _ = channel.send(EngineEvent::LineTruncated { limit });
                }
            })
            .await;
            // Session ended (clean close or unexpected death): unfreeze the UI.
            let _ = channel.send(EngineEvent::Stopped);
            tracing::info!(workspace = %reader_id, "engine session reader exited");
        });

        // Stderr drains to logs only — never surfaced raw to the UI (spec 2.6).
        let err_id = id.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    tracing::warn!(workspace = %err_id, "claude stderr: {line}");
                }
            }
        });

        let ws = Arc::new(Workspace {
            stdin: Mutex::new(Some(stdin)),
            child: Mutex::new(Some(child)),
            interrupting,
            next_request: AtomicU64::new(0),
        });
        self.workspaces.lock().await.insert(id.clone(), ws);
        tracing::info!(
            workspace = %id,
            cwd = %cwd.display(),
            resume = resume.as_deref().unwrap_or("-"),
            fork,
            "engine session opened"
        );
        Ok(id)
    }

    /// Write one turn (a user message) to the session's stdin.
    pub async fn send(&self, workspace_id: &str, prompt: &str) -> IpcResult<()> {
        let ws = self.get(workspace_id).await?;
        // Clear any stale interrupt flag so it can't bleed into this fresh turn.
        ws.interrupting.store(false, Ordering::SeqCst);
        let line = serde_json::to_string(&json!({
            "type": "user",
            "message": { "role": "user", "content": [{ "type": "text", "text": prompt }] },
        }))
        .expect("serialize user message")
            + "\n";
        let mut guard = ws.stdin.lock().await;
        let stdin = guard.as_mut().ok_or_else(|| {
            IpcError::new(IpcErrorKind::InvalidInput, "The Claude session is closing")
        })?;
        stdin.write_all(line.as_bytes()).await.map_err(stdin_err)?;
        stdin.flush().await.map_err(stdin_err)?;
        Ok(())
    }

    /// Interrupt the in-flight turn (the session survives, spec 2.3). The
    /// resulting terminal `result` is translated to `Stopped` by the reader.
    pub async fn cancel(&self, workspace_id: &str) -> IpcResult<()> {
        let ws = self.get(workspace_id).await?;
        ws.interrupting.store(true, Ordering::SeqCst);
        let req_id = format!("int-{}", ws.next_request.fetch_add(1, Ordering::SeqCst));
        let line = serde_json::to_string(&json!({
            "type": "control_request",
            "request_id": req_id,
            "request": { "subtype": "interrupt" },
        }))
        .expect("serialize interrupt")
            + "\n";
        let mut guard = ws.stdin.lock().await;
        if let Some(stdin) = guard.as_mut() {
            stdin.write_all(line.as_bytes()).await.map_err(stdin_err)?;
            stdin.flush().await.map_err(stdin_err)?;
        }
        Ok(())
    }

    /// Answer a pending `can_use_tool` permission request (P1, spec 3.6) by
    /// writing a `control_response` to the session's stdin, echoing the original
    /// `request_id`. `allow` runs the tool with `updated_input` (the edited or
    /// original proposed input — the "Edit" path); a deny passes `message`. The
    /// nesting (`response.subtype = success`, inner `response.behavior`) matches
    /// the control protocol verified against the installed CLI.
    pub async fn resolve_permission(
        &self,
        workspace_id: &str,
        request_id: &str,
        allow: bool,
        updated_input: Option<Value>,
        message: Option<String>,
    ) -> IpcResult<()> {
        let ws = self.get(workspace_id).await?;
        let inner = if allow {
            json!({ "behavior": "allow", "updatedInput": updated_input.unwrap_or(json!({})) })
        } else {
            json!({ "behavior": "deny", "message": message.unwrap_or_else(|| "Denied".into()) })
        };
        let line = serde_json::to_string(&json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": request_id, "response": inner },
        }))
        .expect("serialize permission response")
            + "\n";
        let mut guard = ws.stdin.lock().await;
        let stdin = guard.as_mut().ok_or_else(|| {
            IpcError::new(IpcErrorKind::InvalidInput, "The Claude session is closing")
        })?;
        stdin.write_all(line.as_bytes()).await.map_err(stdin_err)?;
        stdin.flush().await.map_err(stdin_err)?;
        Ok(())
    }

    /// Close a session: drop stdin (the CLI exits on EOF), then wait — killing
    /// as a fallback — so the child is reaped with no zombie (spec 2.5).
    pub async fn close(&self, workspace_id: &str) -> IpcResult<()> {
        let ws = self.workspaces.lock().await.remove(workspace_id);
        if let Some(ws) = ws {
            shutdown_workspace(&ws).await;
        }
        Ok(())
    }

    /// Tear down every session on app exit (spec 2.5 "zero zombies").
    pub async fn shutdown_all(&self) {
        let all: Vec<Arc<Workspace>> = {
            let mut map = self.workspaces.lock().await;
            map.drain().map(|(_, ws)| ws).collect()
        };
        for ws in all {
            shutdown_workspace(&ws).await;
        }
    }

    async fn get(&self, workspace_id: &str) -> IpcResult<Arc<Workspace>> {
        self.workspaces
            .lock()
            .await
            .get(workspace_id)
            .cloned()
            .ok_or_else(|| IpcError::new(IpcErrorKind::InvalidInput, "That workspace is not open"))
    }
}

/// Close stdin (graceful exit on EOF), then wait with a timeout, killing and
/// reaping as a fallback.
async fn shutdown_workspace(ws: &Workspace) {
    drop(ws.stdin.lock().await.take());
    let mut guard = ws.child.lock().await;
    if let Some(mut child) = guard.take() {
        if tokio::time::timeout(Duration::from_secs(3), child.wait())
            .await
            .is_err()
        {
            let _ = child.start_kill();
            let _ = child.wait().await; // reap so there is no zombie
        }
    }
}

fn stdin_err(e: std::io::Error) -> IpcError {
    IpcError::new(
        IpcErrorKind::Internal,
        format!("Failed to write to the Claude session: {e}"),
    )
}

/// Resolve and validate the working directory. Phase 1 defaults to the launch
/// directory; a caller-supplied path must already exist.
fn resolve_cwd(cwd: Option<String>) -> IpcResult<PathBuf> {
    // Shared with the Sessions rail (spec 3.2) so the session this engine
    // creates lands in the project dir the rail watches.
    crate::workspace::resolve_cwd(cwd)
}

/// Validate an optional `--model` value. Accepts the short aliases the CLI
/// documents ("opus"/"sonnet"/"haiku"/"fable"/"default") or a full `claude-*`
/// id (lowercase letters, digits, `.`/`-`). None/blank means "no `--model`"
/// (the CLI's own default). Anything else is rejected rather than passed
/// through — the picker only offers valid values, so this is defense-in-depth.
fn validate_model(model: Option<String>) -> IpcResult<Option<String>> {
    let Some(raw) = model else { return Ok(None) };
    let m = raw.trim();
    if m.is_empty() || m == "default" {
        return Ok(None);
    }
    let alias = matches!(m, "opus" | "sonnet" | "haiku" | "fable");
    let full = m.starts_with("claude-")
        && m.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.');
    if alias || full {
        Ok(Some(m.to_string()))
    } else {
        Err(IpcError::new(
            IpcErrorKind::InvalidInput,
            "Unrecognized model — use an alias (opus/sonnet/haiku/fable) or a claude-* id",
        ))
    }
}

/// Validate an optional `--effort` value against the CLI's fixed set (verified
/// via `claude --help`: low/medium/high/xhigh/max). None/blank means "no
/// `--effort`" (the CLI's own default). The picker only offers valid levels, so
/// this is defense-in-depth.
fn validate_effort(effort: Option<String>) -> IpcResult<Option<String>> {
    let Some(raw) = effort else { return Ok(None) };
    let e = raw.trim();
    if e.is_empty() {
        return Ok(None);
    }
    if matches!(e, "low" | "medium" | "high" | "xhigh" | "max") {
        Ok(Some(e.to_string()))
    } else {
        Err(IpcError::new(
            IpcErrorKind::InvalidInput,
            "Unrecognized effort — use one of low/medium/high/xhigh/max",
        ))
    }
}

/// Per-line byte cap for the engine's NDJSON stream (DoS guard, hardening B2).
/// Generous for legitimate events (a large tool result or file content) but
/// bounds memory against a runaway or malicious stream that emits bytes without
/// a newline — without this, one such line would grow the process unbounded.
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024; // 16 MiB

/// One unit yielded by [`read_bounded_lines`].
enum LineEvent<'a> {
    /// A complete NDJSON line, newline excluded.
    Line(&'a str),
    /// A line exceeded [`MAX_LINE_BYTES`] and was dropped; the reader resynced at
    /// the next newline. `limit` is the cap that was exceeded.
    Truncated { limit: usize },
}

/// Read newline-delimited lines from `reader`, invoking `sink` for each complete
/// line and once for each over-long line that is dropped. Memory is bounded to
/// the `BufReader` capacity plus at most [`MAX_LINE_BYTES`] regardless of input:
/// bytes are pulled in fixed `fill_buf` chunks, and a line that overflows the cap
/// is dropped (one `Truncated`) then resynced at the next newline — so a stream
/// that never emits a newline can't balloon the process (DoS guard, hardening B2).
async fn read_bounded_lines<R, F>(reader: R, mut sink: F)
where
    R: AsyncRead + Unpin,
    F: FnMut(LineEvent<'_>),
{
    let mut reader = BufReader::new(reader);
    let mut line: Vec<u8> = Vec::new();
    // True while discarding the tail of a line that already overflowed the cap.
    let mut dropping = false;
    // A read error ends the loop (the `while let` pattern stops matching); the
    // caller then sends Stopped. An empty `fill_buf` result means EOF.
    while let Ok(available) = reader.fill_buf().await {
        if available.is_empty() {
            break; // EOF
        }
        let consumed = match available.iter().position(|&b| b == b'\n') {
            Some(pos) => {
                if dropping {
                    dropping = false; // the over-long line ends at this newline
                } else if line.len() + pos > MAX_LINE_BYTES {
                    sink(LineEvent::Truncated { limit: MAX_LINE_BYTES });
                    line.clear();
                } else {
                    line.extend_from_slice(&available[..pos]); // newline excluded
                    {
                        let text = String::from_utf8_lossy(&line);
                        sink(LineEvent::Line(text.as_ref()));
                    }
                    line.clear();
                }
                pos + 1 // consume through the newline
            }
            None => {
                let len = available.len();
                if !dropping {
                    if line.len() + len > MAX_LINE_BYTES {
                        // Overflow with no newline yet: drop the line and discard
                        // until the next newline (exactly one Truncated).
                        sink(LineEvent::Truncated { limit: MAX_LINE_BYTES });
                        line.clear();
                        dropping = true;
                    } else {
                        line.extend_from_slice(available);
                    }
                }
                len
            }
        };
        reader.consume(consumed);
    }
    // A trailing partial line at EOF (no final newline) is still a real line.
    if !dropping && !line.is_empty() {
        let text = String::from_utf8_lossy(&line);
        sink(LineEvent::Line(text.as_ref()));
    }
}

// ----- Real `claude --output-format stream-json` line parser (spec 2.3, 3.5) --
//
// Maps one NDJSON line into zero or more `EngineEvent`s. Parse by `type`,
// tolerate unknowns, never panic. Field shapes were probed against the installed
// CLI (2.1.185); the tests below replay real lines to lock this against drift.

/// Parse a single NDJSON line into the events it yields.
pub fn parse_events(line: &str) -> Vec<EngineEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let v: Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => return vec![EngineEvent::ParseError { raw: trimmed.to_string() }],
    };

    match v.get("type").and_then(Value::as_str).unwrap_or("") {
        "system" => match v.get("subtype").and_then(Value::as_str) {
            Some("init") => vec![EngineEvent::Init {
                session_id: str_field(&v, "session_id"),
                model: str_field(&v, "model"),
                slash_commands: string_vec(v.get("slash_commands")),
                tools: string_vec(v.get("tools")),
            }],
            other => vec![EngineEvent::RawSystemEvent {
                kind: format!("system/{}", other.unwrap_or("?")),
                raw: v.clone(),
            }],
        },

        // Token streaming lives in stream_event > content_block_delta > text_delta.
        // Other sub-events (message/block start/stop, message_delta) aren't rendered.
        "stream_event" => {
            let event = v.get("event");
            let is_text_delta = event
                .and_then(|e| e.get("type"))
                .and_then(Value::as_str)
                == Some("content_block_delta")
                && event
                    .and_then(|e| e.get("delta"))
                    .and_then(|d| d.get("type"))
                    .and_then(Value::as_str)
                    == Some("text_delta");
            if is_text_delta {
                if let Some(text) = event
                    .and_then(|e| e.get("delta"))
                    .and_then(|d| d.get("text"))
                    .and_then(Value::as_str)
                {
                    return vec![EngineEvent::AssistantDelta { text: text.to_string() }];
                }
            }
            Vec::new()
        }

        // Full assistant message: surface tool_use blocks (text already streamed).
        "assistant" => content_blocks(&v)
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
            .map(|b| EngineEvent::ToolUse {
                id: str_field(b, "id"),
                name: str_field(b, "name"),
                input: b.get("input").cloned().unwrap_or(Value::Null),
            })
            .collect(),

        // Echoed user/tool turn: surface tool_result blocks.
        "user" => content_blocks(&v)
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
            .map(|b| EngineEvent::ToolResult {
                id: str_field(b, "tool_use_id"),
                output: b.get("content").cloned().unwrap_or(Value::Null),
                is_error: b.get("is_error").and_then(Value::as_bool).unwrap_or(false),
            })
            .collect(),

        "result" => vec![EngineEvent::Result {
            is_error: v.get("is_error").and_then(Value::as_bool).unwrap_or(false),
            total_cost_usd: v.get("total_cost_usd").and_then(Value::as_f64),
            usage: Usage {
                input_tokens: usage_field(&v, "input_tokens"),
                output_tokens: usage_field(&v, "output_tokens"),
                cache_read_input_tokens: usage_field(&v, "cache_read_input_tokens"),
                cache_creation_input_tokens: usage_field(&v, "cache_creation_input_tokens"),
            },
            session_id: str_field(&v, "session_id"),
        }],

        // A control request *from* the CLI. The only one we act on is
        // `can_use_tool` (the permission ask, spec 3.6); the `request_id` sits at
        // the top level and must be echoed back verbatim in the response. Other
        // control subtypes are benign and ignored.
        "control_request" => {
            // Bind `request` first so the permission fields are read from a value
            // that is structurally present — no `unwrap` a future change to the
            // guard could turn into a panic. Only `can_use_tool` is actionable.
            match v.get("request") {
                Some(req)
                    if req.get("subtype").and_then(Value::as_str) == Some("can_use_tool") =>
                {
                    vec![EngineEvent::PermissionRequest {
                        request_id: str_field(&v, "request_id"),
                        tool: str_field(req, "tool_name"),
                        input: req.get("input").cloned().unwrap_or(Value::Null),
                        tool_use_id: str_field(req, "tool_use_id"),
                    }]
                }
                _ => vec![EngineEvent::Unknown { kind: "control_request".into() }],
            }
        }

        "" => vec![EngineEvent::Unknown { kind: "<missing type>".into() }],
        // Real, confirmed-present type; unmodeled schema (Addendum III §S10) —
        // captured raw instead of discarded so a real occurrence is inspectable.
        "rate_limit_event" => {
            vec![EngineEvent::RawSystemEvent { kind: "rate_limit_event".into(), raw: v.clone() }]
        }
        // control_response and any future top-level types: benign.
        other => vec![EngineEvent::Unknown { kind: other.to_string() }],
    }
}

fn str_field(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn usage_field(result: &Value, key: &str) -> u64 {
    result
        .get("usage")
        .and_then(|u| u.get(key))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

fn string_vec(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

fn content_blocks(v: &Value) -> Vec<Value> {
    v.get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Real lines captured from `claude 2.1.185 --output-format stream-json`.
    const INIT: &str = r#"{"type":"system","subtype":"init","cwd":"/x","session_id":"sess-123","tools":["Read","Bash"],"mcp_servers":[],"model":"claude-opus-4-8","permissionMode":"default","slash_commands":["clear","rewind"]}"#;
    const DELTA: &str = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"h"}},"session_id":"sess-123"}"#;
    const MSG_START: &str = r#"{"type":"stream_event","event":{"type":"message_start","message":{}},"session_id":"s"}"#;
    const ASSISTANT_TOOL: &str = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"},{"type":"tool_use","id":"tu-1","name":"Read","input":{"file_path":"a.rs"}}]},"session_id":"s"}"#;
    const USER_RESULT: &str = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu-1","content":"data","is_error":false}]},"session_id":"s"}"#;
    const RESULT: &str = r#"{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.12,"session_id":"sess-123","usage":{"input_tokens":100,"output_tokens":7,"cache_read_input_tokens":39149,"cache_creation_input_tokens":512}}"#;

    #[test]
    fn parses_init() {
        match &parse_events(INIT)[..] {
            [EngineEvent::Init { session_id, model, slash_commands, tools }] => {
                assert_eq!(session_id, "sess-123");
                assert_eq!(model, "claude-opus-4-8");
                assert_eq!(slash_commands, &vec!["clear".to_string(), "rewind".to_string()]);
                assert_eq!(tools.len(), 2);
            }
            other => panic!("expected Init, got {other:?}"),
        }
    }

    #[test]
    fn parses_text_delta() {
        assert!(matches!(&parse_events(DELTA)[..], [EngineEvent::AssistantDelta { text }] if text == "h"));
    }

    #[test]
    fn validate_model_accepts_and_rejects() {
        // Aliases and full ids pass through.
        assert_eq!(validate_model(Some("sonnet".into())).unwrap(), Some("sonnet".into()));
        assert_eq!(validate_model(Some("claude-opus-4-8".into())).unwrap(), Some("claude-opus-4-8".into()));
        // None / blank / "default" mean "no --model" (CLI default).
        assert_eq!(validate_model(None).unwrap(), None);
        assert_eq!(validate_model(Some("".into())).unwrap(), None);
        assert_eq!(validate_model(Some("default".into())).unwrap(), None);
        // Garbage and flag-like values are rejected, not passed to the CLI.
        assert!(validate_model(Some("--dangerous".into())).is_err());
        assert!(validate_model(Some("gpt-4".into())).is_err());
        assert!(validate_model(Some("claude-; rm -rf".into())).is_err());
    }

    #[test]
    fn validate_effort_accepts_and_rejects() {
        assert_eq!(validate_effort(Some("high".into())).unwrap(), Some("high".into()));
        assert_eq!(validate_effort(Some("xhigh".into())).unwrap(), Some("xhigh".into()));
        assert_eq!(validate_effort(None).unwrap(), None);
        assert_eq!(validate_effort(Some("".into())).unwrap(), None);
        assert!(validate_effort(Some("ultra".into())).is_err());
        assert!(validate_effort(Some("--flag".into())).is_err());
    }

    #[test]
    fn ignores_non_text_stream_events() {
        assert!(parse_events(MSG_START).is_empty());
    }

    #[test]
    fn extracts_tool_use_only() {
        match &parse_events(ASSISTANT_TOOL)[..] {
            [EngineEvent::ToolUse { id, name, .. }] => {
                assert_eq!(id, "tu-1");
                assert_eq!(name, "Read");
            }
            other => panic!("expected one ToolUse, got {other:?}"),
        }
    }

    #[test]
    fn parses_tool_result() {
        assert!(matches!(
            &parse_events(USER_RESULT)[..],
            [EngineEvent::ToolResult { id, is_error, .. }] if id == "tu-1" && !is_error
        ));
    }

    #[test]
    fn parses_result() {
        match &parse_events(RESULT)[..] {
            [EngineEvent::Result { is_error, total_cost_usd, usage, session_id }] => {
                assert!(!is_error);
                assert_eq!(*total_cost_usd, Some(0.12));
                assert_eq!(usage.input_tokens, 100);
                assert_eq!(usage.output_tokens, 7);
                assert_eq!(usage.cache_read_input_tokens, 39149);
                assert_eq!(usage.cache_creation_input_tokens, 512);
                assert_eq!(session_id, "sess-123");
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn bad_json_is_parse_error() {
        assert!(matches!(&parse_events("{not json")[..], [EngineEvent::ParseError { .. }]));
    }

    #[test]
    fn unknown_type_is_unknown() {
        assert!(matches!(
            &parse_events(r#"{"type":"control_response","foo":1}"#)[..],
            [EngineEvent::Unknown { kind }] if kind == "control_response"
        ));
    }

    #[test]
    fn rate_limit_event_is_captured_raw_not_discarded() {
        match &parse_events(r#"{"type":"rate_limit_event","resetsAt":"2026-07-03T00:00:00Z","status":"allowed"}"#)[..] {
            [EngineEvent::RawSystemEvent { kind, raw }] => {
                assert_eq!(kind, "rate_limit_event");
                assert_eq!(raw["status"], "allowed");
                assert_eq!(raw["resetsAt"], "2026-07-03T00:00:00Z");
            }
            other => panic!("expected RawSystemEvent, got {other:?}"),
        }
    }

    #[test]
    fn unrecognized_system_subtype_is_captured_raw() {
        match &parse_events(r#"{"type":"system","subtype":"status","detail":"requesting"}"#)[..] {
            [EngineEvent::RawSystemEvent { kind, raw }] => {
                assert_eq!(kind, "system/status");
                assert_eq!(raw["detail"], "requesting");
            }
            other => panic!("expected RawSystemEvent, got {other:?}"),
        }
    }

    // Real `can_use_tool` control request captured from claude 2.1.191 run with
    // `--permission-prompt-tool stdio` (the P1 permission ask, spec 3.6).
    const CAN_USE_TOOL: &str = r#"{"type":"control_request","request_id":"req-9","request":{"subtype":"can_use_tool","tool_name":"Write","display_name":"Write","input":{"file_path":"/x/a.txt","content":"hi"},"description":"a.txt","permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],"tool_use_id":"toolu_7"}}"#;

    #[test]
    fn parses_can_use_tool_permission_request() {
        match &parse_events(CAN_USE_TOOL)[..] {
            [EngineEvent::PermissionRequest { request_id, tool, input, tool_use_id }] => {
                assert_eq!(request_id, "req-9"); // top-level id, echoed in the response
                assert_eq!(tool, "Write");
                assert_eq!(tool_use_id, "toolu_7");
                assert_eq!(input.get("file_path").and_then(Value::as_str), Some("/x/a.txt"));
            }
            other => panic!("expected PermissionRequest, got {other:?}"),
        }
    }

    #[test]
    fn other_control_request_subtypes_are_benign() {
        assert!(matches!(
            &parse_events(r#"{"type":"control_request","request_id":"r","request":{"subtype":"mcp_message"}}"#)[..],
            [EngineEvent::Unknown { kind }] if kind == "control_request"
        ));
    }

    #[test]
    fn control_request_without_request_field_is_benign() {
        // No `request` object at all: must be Unknown, never a panic (B3 totality).
        assert!(matches!(
            &parse_events(r#"{"type":"control_request","request_id":"r"}"#)[..],
            [EngineEvent::Unknown { kind }] if kind == "control_request"
        ));
    }

    // ----- Bounded line reader (hardening B2) --------------------------------

    /// Drive `read_bounded_lines` over an in-memory reader, tagging each unit so
    /// lines and truncations are distinguishable and ordered.
    fn collect_lines(input: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        tauri::async_runtime::block_on(read_bounded_lines(input, |unit| match unit {
            LineEvent::Line(l) => out.push(format!("L:{l}")),
            LineEvent::Truncated { limit } => out.push(format!("T:{limit}")),
        }));
        out
    }

    #[test]
    fn bounded_reader_splits_complete_lines() {
        assert_eq!(collect_lines(b"one\ntwo\nthree\n"), vec!["L:one", "L:two", "L:three"]);
    }

    #[test]
    fn bounded_reader_emits_trailing_partial_line() {
        // A final line with no trailing newline is still a real line (EOF mid-line).
        assert_eq!(collect_lines(b"a\nbc"), vec!["L:a", "L:bc"]);
    }

    #[test]
    fn bounded_reader_drops_overlong_line_and_resyncs() {
        // One line far past the cap (no newline for a long stretch), then a normal
        // line: the over-long line yields exactly one Truncated and is dropped, and
        // the following line parses normally — the reader resynced at the newline.
        let mut input = vec![b'x'; MAX_LINE_BYTES + 4096];
        input.push(b'\n');
        input.extend_from_slice(b"after\n");
        assert_eq!(
            collect_lines(&input),
            vec![format!("T:{MAX_LINE_BYTES}"), "L:after".to_string()],
        );
    }
}
