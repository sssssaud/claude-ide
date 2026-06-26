//! Workspace usage dashboard (P4, Phase 8). Read-only token aggregation over the
//! CLI's own session transcripts.
//!
//! Verified against real data 2026-06-26: the CLI persists **no cost** in its
//! `~/.claude/projects/<slug>/<uuid>.jsonl` — only per-assistant-message token
//! `usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
//! `cache_creation_input_tokens`) and the `model`. So this reports EXACT tokens,
//! per session and in total; any dollar figure is the UI's estimate from editable
//! rates, never read from disk (and meaningless on a flat subscription). Tokens
//! are summed by streaming each transcript line-by-line — never materialised — so
//! a large/active session stays cheap. Never writes `~/.claude`.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use crate::error::IpcResult;

/// Token sums (exact, summed from the transcripts).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenSums {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_creation: u64,
    /// Assistant messages that carried a `usage` block.
    pub messages: u64,
}

impl TokenSums {
    fn add(&mut self, other: &TokenSums) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_creation += other.cache_creation;
        self.messages += other.messages;
    }
}

/// One session's usage row.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRow {
    pub session_id: String,
    pub label: String,
    /// Distinct billable models seen (the synthetic, non-billed model is dropped).
    pub models: Vec<String>,
    pub last_active_ms: u64,
    pub tokens: TokenSums,
}

/// The whole workspace's usage report, rows newest-active first.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub rows: Vec<UsageRow>,
    pub totals: TokenSums,
    pub session_count: usize,
}

/// Aggregate token usage across the workspace's sessions (read-only).
pub fn workspace_usage(cwd: Option<String>) -> IpcResult<UsageReport> {
    // Reuse the rail's session list for ids / labels / newest-first order (it
    // probes head+tail only); we open each transcript fully just for the sums.
    let sessions = crate::sessions::list(cwd.clone())?;
    let target = crate::workspace::resolve_cwd(cwd)?;
    let dir = crate::sessions::claude_projects_dir()
        .and_then(|projects| crate::sessions::resolve_project_dir(&projects, &target));
    let dir = match dir {
        Some(d) => d,
        None => {
            return Ok(UsageReport { rows: Vec::new(), totals: TokenSums::default(), session_count: 0 })
        }
    };

    let mut rows = Vec::with_capacity(sessions.len());
    let mut totals = TokenSums::default();
    for s in sessions {
        let path = dir.join(format!("{}.jsonl", s.id));
        let (tokens, models) = sum_transcript(&path);
        totals.add(&tokens);
        rows.push(UsageRow {
            session_id: s.id,
            label: s.label,
            models,
            last_active_ms: s.last_active_ms,
            tokens,
        });
    }
    let session_count = rows.len();
    Ok(UsageReport { rows, totals, session_count })
}

/// Stream a transcript, summing assistant-message token usage and collecting the
/// distinct billable models. Missing/unreadable file → zeroes.
fn sum_transcript(path: &Path) -> (TokenSums, Vec<String>) {
    let mut tokens = TokenSums::default();
    let mut models: Vec<String> = Vec::new();
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (tokens, models),
    };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        accumulate(&line, &mut tokens, &mut models);
    }
    (tokens, models)
}

/// Fold one transcript line into the running sums. Pure (no IO) so it is
/// golden-tested. Only `assistant` records with a `message.usage` block count;
/// the synthetic (non-billed) model is excluded from the model list.
fn accumulate(line: &str, tokens: &mut TokenSums, models: &mut Vec<String>) {
    // Cheap prefilter: the vast majority of lines (user, meta, file-history, …)
    // carry no usage block, so skip the JSON parse for them.
    if !line.contains("\"usage\"") {
        return;
    }
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return,
    };
    if v.get("type").and_then(Value::as_str) != Some("assistant") {
        return;
    }
    let msg = match v.get("message") {
        Some(m) => m,
        None => return,
    };
    if let Some(model) = msg.get("model").and_then(Value::as_str) {
        if model != "<synthetic>" && !models.iter().any(|m| m == model) {
            models.push(model.to_string());
        }
    }
    if let Some(u) = msg.get("usage").and_then(Value::as_object) {
        let get = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
        tokens.input += get("input_tokens");
        tokens.output += get("output_tokens");
        tokens.cache_read += get("cache_read_input_tokens");
        tokens.cache_creation += get("cache_creation_input_tokens");
        tokens.messages += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fold(raw: &[&str]) -> (TokenSums, Vec<String>) {
        let mut t = TokenSums::default();
        let mut m = Vec::new();
        for line in raw {
            accumulate(line, &mut t, &mut m);
        }
        (t, m)
    }

    #[test]
    fn sums_assistant_usage_and_collects_models() {
        let (t, models) = fold(&[
            // a real assistant turn with full usage + a billable model
            r#"{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":50,"cache_creation_input_tokens":10}}}"#,
            // another turn, same model -> not duplicated in the model list
            r#"{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":5,"output_tokens":7}}}"#,
            // synthetic model is excluded from the model list but its tokens (none) don't matter
            r#"{"type":"assistant","message":{"model":"<synthetic>","usage":{"input_tokens":0,"output_tokens":0}}}"#,
        ]);
        assert_eq!(t.input, 105);
        assert_eq!(t.output, 27);
        assert_eq!(t.cache_read, 50);
        assert_eq!(t.cache_creation, 10);
        assert_eq!(t.messages, 3);
        assert_eq!(models, vec!["claude-opus-4-8".to_string()]);
    }

    #[test]
    fn ignores_non_assistant_and_usage_free_lines() {
        let (t, models) = fold(&[
            r#"{"type":"user","message":{"role":"user","content":"hi"}}"#,
            r#"{"type":"file-history-snapshot","messageId":"x"}"#,
            "not json at all",
            // an assistant text-only turn with no usage block contributes nothing
            r#"{"type":"assistant","message":{"model":"claude-opus-4-8","content":[{"type":"text","text":"hi"}]}}"#,
        ]);
        assert_eq!(t.messages, 0);
        assert_eq!(t.input, 0);
        assert!(models.is_empty());
    }
}
