//! Cross-session search (P5, Phase 8). Read-only full-text search over the
//! workspace's `claude` session transcripts — find which past conversations
//! mention a term, with a snippet of each hit.
//!
//! Searches the *visible conversation* only: user + assistant message text
//! (`isMeta` / `isSidechain` records are skipped, matching the conversation
//! pane). Case-insensitive substring. Results are bounded — capped per session
//! and overall — so a big history stays cheap. Read-only over
//! `~/.claude/projects`; never writes anything.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use crate::error::{IpcError, IpcErrorKind, IpcResult};

const MAX_QUERY_LEN: usize = 200;
/// Snippets kept per session (the session still reports its true total).
const HITS_PER_SESSION: usize = 6;
/// Overall snippet cap across all sessions (sets `truncated`).
const MAX_TOTAL_HITS: usize = 300;
/// Characters of context kept before / after the match in a snippet.
const SNIPPET_BEFORE: usize = 50;
const SNIPPET_AFTER: usize = 90;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHit {
    /// "user" or "assistant".
    pub role: &'static str,
    /// A whitespace-collapsed window around the first match in the message.
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchGroup {
    pub session_id: String,
    pub label: String,
    pub last_active_ms: u64,
    /// Total matching messages in this session (may exceed `hits.len()`).
    pub hit_count: u64,
    pub hits: Vec<SessionHit>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchResults {
    pub groups: Vec<SessionSearchGroup>,
    pub total_hits: u64,
    /// The overall snippet cap was reached (more matches exist than returned).
    pub truncated: bool,
}

/// Search the workspace's session transcripts for `query` (read-only).
pub fn search(cwd: Option<String>, query: &str) -> IpcResult<SessionSearchResults> {
    let q = query.trim();
    if q.is_empty() {
        return Err(IpcError::new(IpcErrorKind::InvalidInput, "Search query is empty"));
    }
    if q.len() > MAX_QUERY_LEN {
        return Err(IpcError::new(IpcErrorKind::InvalidInput, "Search query is too long"));
    }
    let q_lower = q.to_lowercase();

    let sessions = crate::sessions::list(cwd.clone())?;
    let target = crate::workspace::resolve_cwd(cwd)?;
    let dir = crate::sessions::claude_projects_dir()
        .and_then(|projects| crate::sessions::resolve_project_dir(&projects, &target));
    let dir = match dir {
        Some(d) => d,
        None => {
            return Ok(SessionSearchResults { groups: Vec::new(), total_hits: 0, truncated: false })
        }
    };

    let mut groups = Vec::new();
    let mut total_hits: u64 = 0;
    let mut truncated = false;

    for s in sessions {
        let remaining = MAX_TOTAL_HITS.saturating_sub(total_hits as usize);
        if remaining == 0 {
            truncated = true;
            break;
        }
        let cap = HITS_PER_SESSION.min(remaining);
        let path = dir.join(format!("{}.jsonl", s.id));
        let (hits, count) = search_transcript(&path, &q_lower, cap);
        if count == 0 {
            continue;
        }
        total_hits += hits.len() as u64;
        groups.push(SessionSearchGroup {
            session_id: s.id,
            label: s.label,
            last_active_ms: s.last_active_ms,
            hit_count: count,
            hits,
        });
    }

    Ok(SessionSearchResults { groups, total_hits, truncated })
}

/// Stream a transcript, returning up to `cap` snippet hits plus the true count of
/// matching messages.
fn search_transcript(path: &Path, q_lower: &str, cap: usize) -> (Vec<SessionHit>, u64) {
    let mut hits = Vec::new();
    let mut count: u64 = 0;
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (hits, count),
    };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        // Cheap prefilter: skip the JSON parse unless the raw line could match.
        if !line.to_lowercase().contains(q_lower) {
            continue;
        }
        if let Some(hit) = match_line(&line, q_lower) {
            count += 1;
            if hits.len() < cap {
                hits.push(hit);
            }
        }
    }
    (hits, count)
}

/// Match one transcript line against the query; returns a hit (role + snippet) if
/// a visible user/assistant message contains it. Pure (golden-tested).
fn match_line(line: &str, q_lower: &str) -> Option<SessionHit> {
    let v: Value = serde_json::from_str(line).ok()?;
    if v.get("isMeta").and_then(Value::as_bool) == Some(true)
        || v.get("isSidechain").and_then(Value::as_bool) == Some(true)
    {
        return None;
    }
    let role: &'static str = match v.get("type").and_then(Value::as_str) {
        Some("user") => "user",
        Some("assistant") => "assistant",
        _ => return None,
    };
    let text = message_text(&v)?;
    let snippet = snippet_around(&text, q_lower)?;
    Some(SessionHit { role, snippet })
}

/// The plain text of a user/assistant record: a string body, or the concatenated
/// `text` blocks of an array body (tool_use / tool_result / thinking are ignored).
fn message_text(v: &Value) -> Option<String> {
    let content = v.get("message")?.get("content")?;
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(blocks) => {
            let mut buf = String::new();
            for b in blocks {
                if b.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(t) = b.get("text").and_then(Value::as_str) {
                        if !buf.is_empty() {
                            buf.push(' ');
                        }
                        buf.push_str(t);
                    }
                }
            }
            (!buf.is_empty()).then_some(buf)
        }
        _ => None,
    }
}

/// A whitespace-collapsed window around the first (case-insensitive) match, with
/// leading/trailing ellipses when the text is clipped. None if no match.
fn snippet_around(text: &str, q_lower: &str) -> Option<String> {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = collapsed.to_lowercase();
    let byte_idx = lower.find(q_lower)?;
    let chars: Vec<char> = collapsed.chars().collect();
    // Map the byte offset (in `lower`) to a char index, clamped for safety.
    let char_idx = lower[..byte_idx].chars().count().min(chars.len());
    let qlen = q_lower.chars().count();
    let start = char_idx.saturating_sub(SNIPPET_BEFORE);
    let end = (char_idx + qlen + SNIPPET_AFTER).min(chars.len());
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(&chars[start..end]);
    if end < chars.len() {
        out.push('…');
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_user_and_assistant_text_case_insensitively() {
        let u = match_line(
            r#"{"type":"user","message":{"role":"user","content":"Please WIRE the parser"}}"#,
            "wire",
        )
        .unwrap();
        assert_eq!(u.role, "user");
        assert!(u.snippet.to_lowercase().contains("wire"));

        let a = match_line(
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"x"},{"type":"text","text":"I wired the parser up."}]}}"#,
            "wire",
        )
        .unwrap();
        assert_eq!(a.role, "assistant");
    }

    #[test]
    fn skips_meta_sidechain_and_non_message_records() {
        assert!(match_line(
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"wire it"}}"#,
            "wire"
        )
        .is_none());
        assert!(match_line(
            r#"{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"wire"}]}}"#,
            "wire"
        )
        .is_none());
        assert!(match_line(r#"{"type":"ai-title","title":"wire the parser"}"#, "wire").is_none());
        // tool_use text isn't message text → no match on the input payload
        assert!(match_line(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"wire"}}]}}"#,
            "wire"
        )
        .is_none());
    }

    #[test]
    fn snippet_clips_with_ellipses_around_the_match() {
        let long = format!("{} needle {}", "a ".repeat(60), "b ".repeat(60));
        let s = snippet_around(&long, "needle").unwrap();
        assert!(s.contains("needle"));
        assert!(s.starts_with('…') && s.ends_with('…'));
        // a short text isn't clipped
        let short = snippet_around("just a needle here", "needle").unwrap();
        assert_eq!(short, "just a needle here");
    }
}
