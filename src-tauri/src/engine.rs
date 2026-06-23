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
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

use crate::error::{IpcError, IpcErrorKind, IpcResult};

/// Token usage for a turn (subset; grows when the real parser provides more).
#[derive(Debug, Clone, Serialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
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
    Stopped,
    /// A line that could not be parsed — surfaced, never swallowed (spec 2.3).
    ParseError { raw: String },
    /// A newer-CLI event type we don't model — logged, benign (spec 2.3).
    Unknown { kind: String },
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
        channel: Channel<EngineEvent>,
    ) -> IpcResult<String> {
        let cwd = resolve_cwd(cwd)?;
        let claude = locate_claude()?;

        let mut child = Command::new(&claude)
            .args([
                "-p",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--include-partial-messages",
                "--verbose",
                "--strict-mcp-config",
            ])
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

        // Reader: stdout -> parse_events -> channel. Interrupt-aware — a `result`
        // arriving while an interrupt is pending becomes a clean `Stopped`.
        let reader_flag = interrupting.clone();
        let reader_id = id.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        for ev in parse_events(&line) {
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
                    Ok(None) => break, // stdout closed: the session ended
                    Err(e) => {
                        tracing::warn!(workspace = %reader_id, error = %e, "engine stdout read error");
                        break;
                    }
                }
            }
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
        tracing::info!(workspace = %id, cwd = %cwd.display(), "engine session opened");
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

/// Resolve the absolute `claude` path (GUI launches may have a thin PATH).
fn locate_claude() -> IpcResult<PathBuf> {
    which::which("claude")
        .map_err(|_| IpcError::new(IpcErrorKind::Internal, "`claude` was not found on PATH"))
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
            other => vec![EngineEvent::Unknown { kind: format!("system/{}", other.unwrap_or("?")) }],
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
            },
            session_id: str_field(&v, "session_id"),
        }],

        "" => vec![EngineEvent::Unknown { kind: "<missing type>".into() }],
        // rate_limit_event, control_response, and any future top-level types: benign.
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
    const RESULT: &str = r#"{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.12,"session_id":"sess-123","usage":{"input_tokens":100,"output_tokens":7}}"#;

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
            &parse_events(r#"{"type":"rate_limit_event","foo":1}"#)[..],
            [EngineEvent::Unknown { kind }] if kind == "rate_limit_event"
        ));
    }
}
