//! The engine: the typed event contract + the turn runner (spec 2.3).
//!
//! Phase 1 is mock-first (spec 6.3 "fake before real"): `run_mock_turn` replays
//! a canned, id-keyed event sequence over a `Channel<EngineEvent>` so the
//! conversation pane and the whole event pipeline can be proven before the real
//! `claude` session is wired. The `EngineEvent` enum is the binding contract,
//! mirrored 1:1 in `src/ipc/types.ts`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;

/// Token usage for a turn (subset; grows when the real parser provides more).
#[derive(Debug, Clone, Serialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// The typed engine event (spec 2.3), serialized internally-tagged by `type`
/// (snake_case) to match the TS mirror. Variants are added as each phase
/// constructs them: Phase 1 streams a turn; `ParseError`/`Unknown` arrive with
/// the real NDJSON parser; `PermissionRequest` with the review queue (Phase 6).
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

/// Tracks in-flight turns so they can be cancelled. A turn checks its flag
/// between emits and ends cleanly with `Stopped` (spec 2.3 cancellation).
#[derive(Default)]
pub struct EngineRegistry {
    next_turn: AtomicU64,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl EngineRegistry {
    /// Allocate a turn id + its cancel flag.
    pub fn begin_turn(&self) -> (String, Arc<AtomicBool>) {
        let n = self.next_turn.fetch_add(1, Ordering::SeqCst);
        let turn_id = format!("turn-{n}");
        let flag = Arc::new(AtomicBool::new(false));
        self.cancels
            .lock()
            .expect("engine registry mutex poisoned")
            .insert(turn_id.clone(), flag.clone());
        (turn_id, flag)
    }

    /// Request cancellation of a turn (no-op if it already finished).
    pub fn cancel(&self, turn_id: &str) {
        if let Some(flag) = self
            .cancels
            .lock()
            .expect("engine registry mutex poisoned")
            .get(turn_id)
        {
            flag.store(true, Ordering::SeqCst);
        }
    }

    fn end_turn(&self, turn_id: &str) {
        self.cancels
            .lock()
            .expect("engine registry mutex poisoned")
            .remove(turn_id);
    }
}

/// Replay a canned turn over the channel, honoring cancellation. Stands in for
/// the real `claude` session until step 4 of Phase 1.
pub async fn run_mock_turn(
    registry: Arc<EngineRegistry>,
    turn_id: String,
    cancel: Arc<AtomicBool>,
    prompt: String,
    channel: Channel<EngineEvent>,
) {
    let cancelled = || cancel.load(Ordering::SeqCst);

    // Init — the same shape the real session reports first.
    let _ = channel.send(EngineEvent::Init {
        session_id: "mock-session-0001".into(),
        model: "claude-opus-4-8 (mock)".into(),
        slash_commands: vec!["/clear".into(), "/rewind".into(), "/branch".into()],
        tools: vec!["Read".into(), "Edit".into(), "Bash".into()],
    });

    let intro = format!(
        "Mock engine here. You said: \"{}\". This proves the streaming pipeline end to end — the real claude session gets wired next.",
        prompt.trim()
    );
    if !stream_text(&intro, &cancel, &channel).await {
        return finish_stopped(&registry, &turn_id, &channel);
    }

    // A tool round-trip, to exercise the tool-use / tool-result cards.
    let _ = channel.send(EngineEvent::ToolUse {
        id: "tool-1".into(),
        name: "Read".into(),
        input: json!({ "file_path": "src-tauri/src/engine.rs" }),
    });
    tokio::time::sleep(Duration::from_millis(250)).await;
    if cancelled() {
        return finish_stopped(&registry, &turn_id, &channel);
    }
    let _ = channel.send(EngineEvent::ToolResult {
        id: "tool-1".into(),
        output: json!("// engine.rs read (mock output)"),
        is_error: false,
    });

    if !stream_text(" Done — that's the mock tool round-trip.", &cancel, &channel).await {
        return finish_stopped(&registry, &turn_id, &channel);
    }

    let _ = channel.send(EngineEvent::Result {
        is_error: false,
        total_cost_usd: Some(0.0123),
        usage: Usage { input_tokens: 1234, output_tokens: 567 },
        session_id: "mock-session-0001".into(),
    });
    registry.end_turn(&turn_id);
}

/// Stream `text` word-by-word as `AssistantDelta`s. Returns `false` if cancelled.
async fn stream_text(text: &str, cancel: &Arc<AtomicBool>, channel: &Channel<EngineEvent>) -> bool {
    for chunk in text.split_inclusive(' ') {
        if cancel.load(Ordering::SeqCst) {
            return false;
        }
        let _ = channel.send(EngineEvent::AssistantDelta { text: chunk.to_string() });
        tokio::time::sleep(Duration::from_millis(45)).await;
    }
    true
}

fn finish_stopped(registry: &Arc<EngineRegistry>, turn_id: &str, channel: &Channel<EngineEvent>) {
    let _ = channel.send(EngineEvent::Stopped);
    registry.end_turn(turn_id);
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
        // rate_limit_event and any future top-level types: benign, logged.
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
