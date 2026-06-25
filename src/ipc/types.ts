/*
 * TypeScript mirror of the backend IPC types (spec 2.3, 2.4).
 *
 * Kept in lockstep with the Rust side by hand. Phase 0 covers preflight, perf,
 * and the error envelope; EngineEvent and the workspace types arrive with their
 * phases.
 */

/** Mirror of Rust `IpcErrorKind`. Grows per phase alongside the Rust enum. */
export type IpcErrorKind = "internal" | "invalid_input";

/** Mirror of Rust `IpcError` — the structured error that crosses IPC. */
export interface IpcError {
  kind: IpcErrorKind;
  message: string;
  detail?: string;
}

/** Mirror of Rust `PreflightReport` (spec 3.10). */
export interface PreflightReport {
  claudeFound: boolean;
  claudePath: string | null;
  version: string | null;
  authenticated: boolean;
  authDetail: string | null;
  ok: boolean;
}

/** Mirror of Rust `PerfStats` (spec 2.7). */
export interface PerfStats {
  coldStartMs: number | null;
  rssBytes: number;
  rssMb: number;
}

/** Mirror of Rust `Usage` (spec 2.3). */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

/** Mirror of Rust `SessionMeta` (spec 3.2) — one session in the rail. */
export interface SessionMeta {
  id: string;
  label: string;
  gitBranch: string | null;
  lastActiveMs: number;
}

/** Mirror of Rust `DirEntry` (Phase 4) — one file-explorer node. */
export interface DirEntry {
  name: string;
  /** Path relative to the workspace root, forward-slashed. */
  path: string;
  isDir: boolean;
}

/** Mirror of Rust `FileContents` (Phase 4) — a file opened in the editor. */
export interface FileContents {
  path: string;
  text: string;
  truncated: boolean;
  binary: boolean;
}

/** Mirror of Rust `GitChange` (Phase 4) — one changed path in a status group. */
export interface GitChange {
  /** Repo-relative path, forward-slashed. */
  path: string;
  /** Original path for a rename/copy (else null). */
  origPath: string | null;
  /** modified | added | deleted | renamed | copied | typechange | untracked | conflicted */
  status: string;
  /** In the staged (index) group vs the unstaged (working-tree) group. */
  staged: boolean;
}

/** Mirror of Rust `GitStatus` (Phase 4) — the source-control panel state. */
export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  changes: GitChange[];
}

/** Mirror of Rust `GitDiff` (Phase 4) — both sides of a file diff. */
export interface GitDiff {
  path: string;
  original: string;
  modified: string;
  staged: boolean;
  binary: boolean;
}

/** Mirror of Rust `GitBranches` (Phase 4) — local branches + the current one. */
export interface GitBranches {
  current: string | null;
  branches: string[];
}

/** Mirror of Rust search types (Phase 4) — ripgrep results grouped by file. */
export interface SearchSegment {
  text: string;
  isMatch: boolean;
}
export interface SearchLine {
  lineNumber: number;
  segments: SearchSegment[];
}
export interface SearchFile {
  path: string;
  lines: SearchLine[];
}
export interface SearchResults {
  files: SearchFile[];
  totalMatches: number;
  truncated: boolean;
}

/** Mirror of Rust `CheckpointEntry` (Phase 7 P2) — one saved file version. */
export interface CheckpointEntry {
  /** Stable key `<hash>@v<N>`. */
  id: string;
  /** Workspace-relative path, forward-slashed. */
  path: string;
  version: number;
  /** The tool that produced it (Write / Edit / …). */
  tool: string;
  timestampMs: number;
}

/** Mirror of Rust `CheckpointTimeline` (Phase 7 P2) — a session's edits, newest first. */
export interface CheckpointTimeline {
  entries: CheckpointEntry[];
}

/** Mirror of Rust `CheckpointDiff` (Phase 7 P2) — a snapshot vs the current file. */
export interface CheckpointDiff {
  path: string;
  snapshot: string;
  current: string;
  binary: boolean;
}

/**
 * Mirror of Rust `EngineEvent` (spec 2.3) — internally tagged by `type`.
 * Render by `type`, never by position; tolerate unknown `type`s from a newer
 * CLI (they are ignored, never crash the pane). Field names match Rust 1:1.
 */
export type EngineEvent =
  | {
      type: "init";
      session_id: string;
      model: string;
      slash_commands: string[];
      tools: string[];
    }
  | { type: "assistant_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: unknown; is_error: boolean }
  | {
      type: "result";
      is_error: boolean;
      total_cost_usd: number | null;
      usage: Usage;
      session_id: string;
    }
  | {
      type: "permission_request";
      request_id: string;
      tool: string;
      input: unknown;
      tool_use_id: string;
    }
  | { type: "stopped" }
  | { type: "parse_error"; raw: string }
  | { type: "unknown"; kind: string };

/** Type guard for errors thrown by the invoke wrappers. */
export function isIpcError(value: unknown): value is IpcError {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "message" in value
  );
}
