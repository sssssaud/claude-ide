//! MCP servers — read-only status for Settings (Addendum III §S12).
//!
//! As a wrapper we never manage MCP server configuration ourselves — the CLI
//! owns that (`claude mcp add/remove/login/logout`, all real, already-
//! interactive commands). Unlike `claude plugin list`, `claude mcp list` has
//! no `--json` output — it prints a human-readable, per-server health-check
//! line. This module is a best-effort, defensively-tolerant parser of that
//! text (tested against real captured output, see the tests below): a line
//! that doesn't fit the expected shape is simply skipped, never fabricated or
//! allowed to panic. Every mutating action runs the CLI's own command through
//! `InlineTerminal` on the frontend — never a new hand-rolled mutation path.

use std::process::Command;

use serde::Serialize;

use crate::error::{AppError, IpcError, IpcErrorKind, IpcResult};

/// One server from `claude mcp list`'s human-readable output.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerEntry {
    pub name: String,
    /// A URL (HTTP/SSE) or a local command (stdio).
    pub target: String,
    /// "HTTP" | "SSE" | "STDIO" | … when the CLI states one explicitly.
    pub transport: Option<String>,
    /// The CLI's own status text verbatim (e.g. "✔ Connected", "! Needs
    /// authentication", "✘ Failed to connect") — never re-worded, so a wording
    /// change upstream degrades gracefully instead of silently lying.
    pub status: String,
}

/// List configured MCP servers via `claude mcp list` (read-only; health-checks
/// each server, so this can take a moment). Runs on a blocking thread.
pub async fn list_mcp_servers() -> IpcResult<Vec<McpServerEntry>> {
    tauri::async_runtime::spawn_blocking(list_blocking)
        .await
        .map_err(|e| IpcError::from(AppError::Io(std::io::Error::other(e.to_string()))))?
}

fn list_blocking() -> IpcResult<Vec<McpServerEntry>> {
    let claude = crate::claude_bin::path()?;
    let out = Command::new(claude).args(["mcp", "list"]).output().map_err(|e| {
        IpcError::new(IpcErrorKind::Internal, format!("Could not run `claude mcp list`: {e}"))
    })?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let line = stderr.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("`claude mcp list` failed");
        return Err(IpcError::new(IpcErrorKind::Internal, line.to_string()));
    }
    Ok(parse_mcp_list(&String::from_utf8_lossy(&out.stdout)))
}

fn parse_mcp_list(stdout: &str) -> Vec<McpServerEntry> {
    stdout.lines().filter_map(parse_mcp_line).collect()
}

/// Parse one `"<name>: <target>[ (<TRANSPORT>)] - <status>"` line. Returns
/// `None` for anything that doesn't fit — progress/header chrome like
/// "Checking MCP server health…" included — never a guessed partial entry.
fn parse_mcp_line(line: &str) -> Option<McpServerEntry> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let colon = line.find(": ")?;
    let name = line[..colon].trim();
    if name.is_empty() {
        return None;
    }
    let rest = &line[colon + 2..];
    let dash = rest.rfind(" - ")?;
    let target_part = rest[..dash].trim();
    let status = rest[dash + 3..].trim();
    if target_part.is_empty() || status.is_empty() {
        return None;
    }

    let (target, transport) = match target_part.rfind(" (") {
        Some(p) if target_part.ends_with(')') => {
            let inner = &target_part[p + 2..target_part.len() - 1];
            if !inner.is_empty() && inner.chars().all(|c| c.is_ascii_alphabetic()) {
                (target_part[..p].trim().to_string(), Some(inner.to_string()))
            } else {
                (target_part.to_string(), None)
            }
        }
        _ => (target_part.to_string(), None),
    };

    Some(McpServerEntry { name: name.to_string(), target, transport, status: status.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Real output captured from `claude mcp list` (CLI 2.1.198) this session.
    const REAL_OUTPUT: &str = "Checking MCP server health…\n\nclaude.ai Adobe for creativity: https://adobe-creativity.adobe.io/mcp - \u{2714} Connected\nclaude.ai Lawve AI: https://mcp.lawve.ai/mcp - ! Needs authentication\nclaude.ai Spotify: https://mcp-gateway-external-pilot.spotify.net/mcp - \u{2714} Connected\nplugin:github:github: https://api.githubcopilot.com/mcp/ (HTTP) - \u{2718} Failed to connect\n";

    #[test]
    fn parses_real_captured_output() {
        let entries = parse_mcp_list(REAL_OUTPUT);
        assert_eq!(entries.len(), 4);
        assert_eq!(
            entries[0],
            McpServerEntry {
                name: "claude.ai Adobe for creativity".into(),
                target: "https://adobe-creativity.adobe.io/mcp".into(),
                transport: None,
                status: "\u{2714} Connected".into(),
            }
        );
        assert_eq!(entries[1].status, "! Needs authentication");
    }

    #[test]
    fn extracts_transport_suffix() {
        let entries = parse_mcp_list(REAL_OUTPUT);
        let gh = entries.iter().find(|e| e.name == "plugin:github:github").unwrap();
        assert_eq!(gh.target, "https://api.githubcopilot.com/mcp/");
        assert_eq!(gh.transport.as_deref(), Some("HTTP"));
        assert_eq!(gh.status, "\u{2718} Failed to connect");
    }

    #[test]
    fn skips_header_and_blank_lines() {
        let entries = parse_mcp_list("Checking MCP server health…\n\n\n");
        assert!(entries.is_empty());
    }

    #[test]
    fn handles_stdio_style_command_target_without_parens() {
        let entries = parse_mcp_list("my-server: npx my-mcp-server - \u{2714} Connected\n");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].target, "npx my-mcp-server");
        assert_eq!(entries[0].transport, None);
    }

    #[test]
    fn empty_output_yields_empty_list() {
        assert!(parse_mcp_list("").is_empty());
    }
}
