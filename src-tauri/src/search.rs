//! Workspace global search (spec 5.A.3, Phase 4) — drives ripgrep (`rg`).
//!
//! `rg` is a generic developer tool (like `git`), not part of `claude`'s agent
//! loop, so shelling out to it does not violate the wrapper rule. It runs with
//! the workspace root as its cwd and respects `.gitignore` (so `target/`,
//! `node_modules/`, `.git/` are skipped for free). The query is passed literally
//! (`--fixed-strings`) after `--`, so it can neither be a regex surprise nor a
//! smuggled flag. Output is capped to keep the IPC payload bounded.

use std::process::Command;

use serde::Serialize;
use serde_json::Value;

use crate::error::{IpcError, IpcErrorKind, IpcResult};

/// Cap on total matches returned across all files (UI notes when it is hit).
const MAX_TOTAL_MATCHES: usize = 2000;
/// Per-file match cap handed to rg, so one giant file can't dominate.
const MAX_PER_FILE: &str = "200";
/// Truncate very long lines (e.g. minified files) so the payload stays small.
const MAX_LINE_LEN: usize = 400;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub files: Vec<SearchFile>,
    pub total_matches: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFile {
    pub path: String,
    pub lines: Vec<SearchLine>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchLine {
    pub line_number: u32,
    pub segments: Vec<Segment>,
}

/// One run of a matched line, flagged so the UI can highlight `is_match` runs.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub text: String,
    pub is_match: bool,
}

/// Search the workspace for a literal `query` (case-smart). Matches come back
/// grouped by file, each line split into highlighted / plain segments.
pub fn search(cwd: Option<String>, query: String) -> IpcResult<SearchResults> {
    let root = crate::workspace::resolve_cwd(cwd)?;
    let q = query.trim();
    if q.is_empty() {
        return Err(IpcError::new(IpcErrorKind::InvalidInput, "Search query is empty"));
    }
    if q.len() > 500 {
        return Err(IpcError::new(IpcErrorKind::InvalidInput, "Search query is too long"));
    }

    let out = Command::new("rg")
        .current_dir(&root)
        .args(["--json", "--fixed-strings", "--smart-case", "--max-count", MAX_PER_FILE, "--"])
        .arg(q)
        .output()
        .map_err(|e| {
            IpcError::new(IpcErrorKind::Internal, format!("Could not run ripgrep (rg): {e}"))
        })?;
    // rg exits 1 when there are simply no matches — that is success for us.
    match out.status.code() {
        Some(0) | Some(1) => Ok(parse_rg_json(&out.stdout)),
        _ => Err(IpcError::new(
            IpcErrorKind::Internal,
            format!("ripgrep failed: {}", String::from_utf8_lossy(&out.stderr).trim()),
        )),
    }
}

/// Parse `rg --json` NDJSON into grouped results. Pure (unit-tested). rg emits
/// all of a file's matches consecutively, so grouping is just "same path as the
/// last file?".
fn parse_rg_json(bytes: &[u8]) -> SearchResults {
    let text = String::from_utf8_lossy(bytes);
    let mut files: Vec<SearchFile> = Vec::new();
    let mut total = 0usize;
    let mut truncated = false;

    for line in text.lines() {
        if total >= MAX_TOTAL_MATCHES {
            truncated = true;
            break;
        }
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("type").and_then(Value::as_str) != Some("match") {
            continue;
        }
        let data = match v.get("data") {
            Some(d) => d,
            None => continue,
        };
        let path = data.get("path").and_then(|p| p.get("text")).and_then(Value::as_str).unwrap_or("");
        if path.is_empty() {
            continue;
        }
        let line_number = data.get("line_number").and_then(Value::as_u64).unwrap_or(0) as u32;
        let raw = data.get("lines").and_then(|l| l.get("text")).and_then(Value::as_str).unwrap_or("");
        let segments = build_segments(raw, data.get("submatches").and_then(Value::as_array));

        if files.last().map(|f| f.path != path).unwrap_or(true) {
            files.push(SearchFile { path: path.to_string(), lines: Vec::new() });
        }
        // `last_mut` is Some here — a group was just pushed, or the last group
        // already matched `path`. Bind it instead of unwrapping so a future
        // change to the grouping can't turn this into a panic across IPC.
        if let Some(file) = files.last_mut() {
            file.lines.push(SearchLine { line_number, segments });
            total += 1;
        }
    }

    SearchResults { files, total_matches: total, truncated }
}

/// Split a matched line into highlighted (`is_match`) and plain runs using rg's
/// submatch byte offsets. Defensive: out-of-range or non-char-boundary offsets
/// are skipped, so it never panics and always shows the line.
fn build_segments(raw: &str, submatches: Option<&Vec<Value>>) -> Vec<Segment> {
    let line = raw.strip_suffix('\n').unwrap_or(raw);
    let line = line.strip_suffix('\r').unwrap_or(line);
    // Truncate very long lines, keeping the front (where matches usually are).
    let (line, cut) = if line.len() > MAX_LINE_LEN {
        let mut end = MAX_LINE_LEN;
        while end > 0 && !line.is_char_boundary(end) {
            end -= 1;
        }
        (&line[..end], true)
    } else {
        (line, false)
    };

    let mut ranges: Vec<(usize, usize)> = submatches
        .map(|subs| {
            subs.iter()
                .filter_map(|s| {
                    let start = s.get("start").and_then(Value::as_u64)? as usize;
                    let end = s.get("end").and_then(Value::as_u64)? as usize;
                    (start < end
                        && end <= line.len()
                        && line.is_char_boundary(start)
                        && line.is_char_boundary(end))
                    .then_some((start, end))
                })
                .collect()
        })
        .unwrap_or_default();
    ranges.sort_by_key(|r| r.0);

    let mut segs: Vec<Segment> = Vec::new();
    let mut cursor = 0usize;
    for (s, e) in ranges {
        if s < cursor {
            continue; // skip overlapping submatches
        }
        if s > cursor {
            push(&mut segs, &line[cursor..s], false);
        }
        push(&mut segs, &line[s..e], true);
        cursor = e;
    }
    if cursor < line.len() {
        push(&mut segs, &line[cursor..], false);
    }
    if cut {
        push(&mut segs, "…", false);
    }
    if segs.is_empty() {
        push(&mut segs, line, false);
    }
    segs
}

fn push(segs: &mut Vec<Segment>, text: &str, is_match: bool) {
    if !text.is_empty() {
        segs.push(Segment { text: text.to_string(), is_match });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_match_into_highlight_segments() {
        let lines = [
            r#"{"type":"begin","data":{"path":{"text":"a.rs"}}}"#,
            r#"{"type":"match","data":{"path":{"text":"a.rs"},"lines":{"text":"let resolve_cwd = 1;\n"},"line_number":3,"submatches":[{"match":{"text":"resolve_cwd"},"start":4,"end":15}]}}"#,
            r#"{"type":"end","data":{"path":{"text":"a.rs"}}}"#,
            r#"{"type":"summary","data":{}}"#,
        ]
        .join("\n");
        let r = parse_rg_json(lines.as_bytes());
        assert_eq!(r.total_matches, 1);
        assert!(!r.truncated);
        assert_eq!(r.files.len(), 1);
        assert_eq!(r.files[0].path, "a.rs");
        let l = &r.files[0].lines[0];
        assert_eq!(l.line_number, 3);
        assert_eq!(
            l.segments,
            vec![
                Segment { text: "let ".into(), is_match: false },
                Segment { text: "resolve_cwd".into(), is_match: true },
                Segment { text: " = 1;".into(), is_match: false },
            ]
        );
    }

    #[test]
    fn groups_by_file_and_ignores_non_match_events() {
        let lines = [
            r#"{"type":"match","data":{"path":{"text":"a.rs"},"lines":{"text":"foo\n"},"line_number":1,"submatches":[{"match":{"text":"foo"},"start":0,"end":3}]}}"#,
            r#"{"type":"match","data":{"path":{"text":"b.rs"},"lines":{"text":"x foo\n"},"line_number":9,"submatches":[{"match":{"text":"foo"},"start":2,"end":5}]}}"#,
            r#"not json — skipped"#,
        ]
        .join("\n");
        let r = parse_rg_json(lines.as_bytes());
        assert_eq!(r.files.len(), 2);
        assert_eq!(r.files[0].path, "a.rs");
        assert_eq!(r.files[1].path, "b.rs");
        assert_eq!(r.files[1].lines[0].line_number, 9);
        // leading plain run preserved before the highlight
        assert_eq!(r.files[1].lines[0].segments[0], Segment { text: "x ".into(), is_match: false });
        assert_eq!(r.files[1].lines[0].segments[1], Segment { text: "foo".into(), is_match: true });
    }

    #[test]
    fn match_without_preceding_begin_starts_a_group() {
        // A `match` arriving into an empty result (no `begin`) must create its
        // file group — the path the totality fix protects (B3): no unwrap panic.
        let line = r#"{"type":"match","data":{"path":{"text":"solo.rs"},"lines":{"text":"hit\n"},"line_number":7,"submatches":[{"match":{"text":"hit"},"start":0,"end":3}]}}"#;
        let r = parse_rg_json(line.as_bytes());
        assert_eq!(r.total_matches, 1);
        assert_eq!(r.files.len(), 1);
        assert_eq!(r.files[0].path, "solo.rs");
        assert_eq!(r.files[0].lines[0].line_number, 7);
    }
}
