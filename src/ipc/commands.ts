/*
 * Typed wrappers over Tauri `invoke` (spec 2.4). The rest of the app calls
 * these, never `invoke` directly, so command names and shapes live in one place
 * and errors normalize to `IpcError`.
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
// Type-only: the resumed-session history mirrors the conversation store's item
// shape. Erased at build time, so no runtime import cycle with the store.
import type { ConvItem } from "@/store/conversation";
import type {
  AgentSession,
  CheckpointDiff,
  CheckpointTimeline,
  DaemonStatus,
  DirEntry,
  EngineEvent,
  FileContents,
  GitBranches,
  GitDiff,
  GitStatus,
  PerfStats,
  PreflightReport,
  ProjectPermissions,
  ProjectPermissionsFile,
  SearchResults,
  SessionMeta,
  SessionSearchResults,
  UsageReport,
} from "./types";
import { isIpcError } from "./types";

/** Normalize any thrown value into an `IpcError`-shaped object. */
function normalizeError(e: unknown): never {
  if (isIpcError(e)) throw e;
  throw {
    kind: "internal" as const,
    message: typeof e === "string" ? e : "Unexpected error",
    detail: e instanceof Error ? e.message : undefined,
  };
}

/** Probe the installed `claude` CLI: presence, version, auth. */
export async function preflight(): Promise<PreflightReport> {
  try {
    return await invoke<PreflightReport>("preflight");
  } catch (e) {
    normalizeError(e);
  }
}

/** Tell the backend the UI is ready (anchors the cold-start budget). */
export async function reportReady(): Promise<number> {
  try {
    return await invoke<number>("report_ready");
  } catch (e) {
    normalizeError(e);
  }
}

/** Current perf snapshot (cold start + RSS). */
export async function perfStats(): Promise<PerfStats> {
  try {
    return await invoke<PerfStats>("perf_stats");
  } catch (e) {
    normalizeError(e);
  }
}

/**
 * Open a persistent `claude` engine session. `onEvent` is invoked for every
 * streamed `EngineEvent` for the session's whole lifetime (subscribe once);
 * resolves to the workspace id used by the other engine commands. `cwd`
 * defaults to the app's launch directory.
 */
export async function openWorkspace(
  onEvent: (event: EngineEvent) => void,
  cwd?: string,
): Promise<string> {
  const channel = new Channel<EngineEvent>();
  channel.onmessage = onEvent;
  try {
    return await invoke<string>("open_workspace", { cwd, onEvent: channel });
  } catch (e) {
    normalizeError(e);
  }
}

/**
 * Native "Open Folder…" picker. Resolves to the chosen absolute directory path,
 * or null if the user cancelled. (Single directory; the dialog capability is
 * scoped to open-only.)
 */
export async function pickFolder(): Promise<string | null> {
  try {
    const selected = await openDialog({ directory: true, multiple: false, title: "Open Folder" });
    return typeof selected === "string" ? selected : null;
  } catch (e) {
    normalizeError(e);
  }
}

/** The default workspace root (canonical absolute path) to seed the first tab. */
export async function defaultWorkspace(): Promise<string> {
  try {
    return await invoke<string>("default_workspace");
  } catch (e) {
    normalizeError(e);
  }
}

/** Send one turn into a workspace session; responses arrive over its channel. */
export async function engineSend(workspaceId: string, prompt: string): Promise<void> {
  try {
    await invoke<void>("engine_send", { workspaceId, prompt });
  } catch (e) {
    normalizeError(e);
  }
}

/** Interrupt the in-flight turn in a workspace (the session survives). */
export async function engineCancel(workspaceId: string): Promise<void> {
  try {
    await invoke<void>("engine_cancel", { workspaceId });
  } catch (e) {
    normalizeError(e);
  }
}

/**
 * Answer a pending permission request (P1 change-review queue). `decision` is
 * "allow" or "deny". On allow, `updatedInput` is the tool input to run (the
 * original proposed input, or the user's edited version); on deny, `message` is
 * the reason shown to the agent. The CLI resumes the turn on either answer.
 */
export async function approvePermission(
  workspaceId: string,
  requestId: string,
  decision: "allow" | "deny",
  updatedInput?: unknown,
  message?: string,
): Promise<void> {
  try {
    await invoke<void>("approve_permission", {
      workspaceId,
      requestId,
      decision,
      updatedInput,
      message,
    });
  } catch (e) {
    normalizeError(e);
  }
}

/**
 * Open a session that resumes (or, with `fork`, branches) a past `claude`
 * conversation by id. Events stream over `onEvent` like `openWorkspace`;
 * resolves to the workspace id. History is loaded separately (`readSession`).
 */
export async function resumeWorkspace(
  onEvent: (event: EngineEvent) => void,
  sessionId: string,
  fork: boolean,
  cwd?: string,
): Promise<string> {
  const channel = new Channel<EngineEvent>();
  channel.onmessage = onEvent;
  try {
    return await invoke<string>("resume_workspace", { cwd, sessionId, fork, onEvent: channel });
  } catch (e) {
    normalizeError(e);
  }
}

/** A past session's rendered history (the resume stream does not replay turns). */
export interface SessionTranscript {
  items: ConvItem[];
  truncated: boolean;
}

/** Read a past session's transcript into renderable conversation items. */
export async function readSession(sessionId: string, cwd?: string): Promise<SessionTranscript> {
  try {
    return await invoke<SessionTranscript>("read_session", { cwd, sessionId });
  } catch (e) {
    normalizeError(e);
  }
}

/** Close a workspace session, reaping its `claude` child. */
export async function closeWorkspace(workspaceId: string): Promise<void> {
  try {
    await invoke<void>("close_workspace", { workspaceId });
  } catch (e) {
    normalizeError(e);
  }
}

/**
 * Open a plain shell in a PTY sized `rows`x`cols`. `onData` receives raw shell
 * output as bytes (write straight to xterm); a zero-length chunk is the EOF
 * sentinel (the shell exited). Resolves to the opaque terminal id.
 */
export async function ptyOpen(
  onData: (bytes: Uint8Array) => void,
  rows: number,
  cols: number,
  cwd?: string,
): Promise<string> {
  const channel = new Channel<number[]>();
  channel.onmessage = (msg) => {
    // Rust sends `Vec<u8>`; serde gives a number[]. Tolerate ArrayBuffer/typed
    // arrays in case the transport optimizes binary in a newer Tauri.
    const bytes =
      msg instanceof ArrayBuffer
        ? new Uint8Array(msg)
        : ArrayBuffer.isView(msg as unknown as ArrayBufferView)
          ? new Uint8Array((msg as unknown as ArrayBufferView).buffer)
          : new Uint8Array(msg);
    onData(bytes);
  };
  try {
    return await invoke<string>("pty_open", { cwd, rows, cols, onData: channel });
  } catch (e) {
    normalizeError(e);
  }
}

/** Send keystrokes into a terminal. */
export async function ptyWrite(ptyId: string, data: string): Promise<void> {
  try {
    await invoke<void>("pty_write", { ptyId, data });
  } catch (e) {
    normalizeError(e);
  }
}

/** Resize a terminal's PTY to match the drawer. */
export async function ptyResize(ptyId: string, rows: number, cols: number): Promise<void> {
  try {
    await invoke<void>("pty_resize", { ptyId, rows, cols });
  } catch (e) {
    normalizeError(e);
  }
}

/** Close a terminal, reaping its shell. */
export async function ptyClose(ptyId: string): Promise<void> {
  try {
    await invoke<void>("pty_close", { ptyId });
  } catch (e) {
    normalizeError(e);
  }
}

/**
 * List the workspace's `claude` sessions (read-only), newest activity first.
 * `cwd` defaults to the launch / `CLAUDE_IDE_WORKSPACE` directory.
 */
export async function listSessions(cwd?: string): Promise<SessionMeta[]> {
  try {
    return await invoke<SessionMeta[]>("list_sessions", { cwd });
  } catch (e) {
    normalizeError(e);
  }
}

/**
 * Watch for new/removed sessions; `onChange` receives the refreshed list each
 * time the project's session set changes (subscribe once for the app's life).
 */
export async function watchSessions(
  onChange: (sessions: SessionMeta[]) => void,
  cwd?: string,
): Promise<void> {
  const channel = new Channel<SessionMeta[]>();
  channel.onmessage = onChange;
  try {
    await invoke<void>("watch_sessions", { cwd, onChange: channel });
  } catch (e) {
    normalizeError(e);
  }
}

/**
 * A session's read-only checkpoint timeline (file-history snapshots), newest
 * first. Empty for a session with no recorded edits. `cwd` selects the workspace.
 */
export async function checkpointTimeline(
  sessionId: string,
  cwd?: string,
): Promise<CheckpointTimeline> {
  try {
    return await invoke<CheckpointTimeline>("checkpoint_timeline", { cwd, sessionId });
  } catch (e) {
    normalizeError(e);
  }
}

/** A checkpoint's snapshot vs the current on-disk file (read-only preview). */
export async function checkpointDiff(
  sessionId: string,
  path: string,
  version: number,
  cwd?: string,
): Promise<CheckpointDiff> {
  try {
    return await invoke<CheckpointDiff>("checkpoint_diff", { cwd, sessionId, path, version });
  } catch (e) {
    normalizeError(e);
  }
}

/** List a workspace directory for the file explorer (`path` relative to root);
 *  `cwd` selects the workspace root (defaults to the launch directory). */
export async function listDir(path?: string, cwd?: string): Promise<DirEntry[]> {
  try {
    return await invoke<DirEntry[]>("list_dir", { cwd, path });
  } catch (e) {
    normalizeError(e);
  }
}

/** Read a workspace file's text for the editor (size-capped, binary-guarded). */
export async function readFile(path: string, cwd?: string): Promise<FileContents> {
  try {
    return await invoke<FileContents>("read_file", { cwd, path });
  } catch (e) {
    normalizeError(e);
  }
}

/** Save (overwrite) an existing workspace file. Confined to the workspace root. */
export async function writeFile(path: string, contents: string, cwd?: string): Promise<void> {
  try {
    await invoke<void>("write_file", { cwd, path, contents });
  } catch (e) {
    normalizeError(e);
  }
}

/** Read the project's `.claude/settings.json` permissions block + whether the
 *  file exists yet. Read-only. (Phase 7 7B — P3 permission manager.) */
export async function readPermissions(cwd?: string): Promise<ProjectPermissionsFile> {
  try {
    return await invoke<ProjectPermissionsFile>("read_permissions", { cwd });
  } catch (e) {
    normalizeError(e);
  }
}

/** Write the project's permissions block, preserving every other settings key.
 *  Creates `.claude/settings.json` if absent; validated at the backend boundary. */
export async function writePermissions(
  permissions: ProjectPermissions,
  cwd?: string,
): Promise<void> {
  try {
    await invoke<void>("write_permissions", { cwd, permissions });
  } catch (e) {
    normalizeError(e);
  }
}

/** Per-session + total token usage for the workspace (exact, from transcripts);
 *  the CLI stores no cost, so dollars are an estimate done in the UI. Read-only. */
export async function workspaceUsage(cwd?: string): Promise<UsageReport> {
  try {
    return await invoke<UsageReport>("workspace_usage", { cwd });
  } catch (e) {
    normalizeError(e);
  }
}

/** Working-tree status (staged/unstaged/untracked/conflicted) + branch. */
export async function gitStatus(cwd?: string): Promise<GitStatus> {
  try {
    return await invoke<GitStatus>("git_status", { cwd });
  } catch (e) {
    normalizeError(e);
  }
}

/** Both sides of one file's diff (HEAD→index when `staged`, else index→worktree). */
export async function gitDiff(path: string, staged: boolean, cwd?: string): Promise<GitDiff> {
  try {
    return await invoke<GitDiff>("git_diff", { cwd, path, staged });
  } catch (e) {
    normalizeError(e);
  }
}

/** Stage one path (modification / addition / deletion). */
export async function gitStage(path: string, cwd?: string): Promise<void> {
  try {
    await invoke<void>("git_stage", { cwd, path });
  } catch (e) {
    normalizeError(e);
  }
}

/** Unstage one path (working tree untouched). */
export async function gitUnstage(path: string, cwd?: string): Promise<void> {
  try {
    await invoke<void>("git_unstage", { cwd, path });
  } catch (e) {
    normalizeError(e);
  }
}

/** Stage every change (incl. untracked + deletions). */
export async function gitStageAll(cwd?: string): Promise<void> {
  try {
    await invoke<void>("git_stage_all", { cwd });
  } catch (e) {
    normalizeError(e);
  }
}

/** Unstage everything (reset index to HEAD; working tree untouched). */
export async function gitUnstageAll(cwd?: string): Promise<void> {
  try {
    await invoke<void>("git_unstage_all", { cwd });
  } catch (e) {
    normalizeError(e);
  }
}

/** Commit the staged changes with `message`; resolves to git's summary line. */
export async function gitCommit(message: string, cwd?: string): Promise<string> {
  try {
    return await invoke<string>("git_commit", { cwd, message });
  } catch (e) {
    normalizeError(e);
  }
}

/** Local branches + the checked-out one, for the branch switcher. */
export async function gitBranches(cwd?: string): Promise<GitBranches> {
  try {
    return await invoke<GitBranches>("git_branches", { cwd });
  } catch (e) {
    normalizeError(e);
  }
}

/** Switch to an existing local branch (git refuses if it would lose changes). */
export async function gitSwitchBranch(name: string, cwd?: string): Promise<void> {
  try {
    await invoke<void>("git_switch_branch", { cwd, name });
  } catch (e) {
    normalizeError(e);
  }
}

/** Create a new branch from HEAD and switch to it. */
export async function gitCreateBranch(name: string, cwd?: string): Promise<void> {
  try {
    await invoke<void>("git_create_branch", { cwd, name });
  } catch (e) {
    normalizeError(e);
  }
}

/** Discard a single path's working-tree changes — DESTRUCTIVE. Confirm first. */
export async function gitDiscard(path: string, cwd?: string): Promise<void> {
  try {
    await invoke<void>("git_discard", { cwd, path });
  } catch (e) {
    normalizeError(e);
  }
}

/** Workspace-wide literal search via ripgrep, grouped by file. */
export async function search(query: string, cwd?: string): Promise<SearchResults> {
  try {
    return await invoke<SearchResults>("search", { cwd, query });
  } catch (e) {
    normalizeError(e);
  }
}

/** Full-text search across the workspace's session transcripts (user + assistant
 *  message text), grouped by session with snippets. Read-only. (P5, Phase 8.) */
export async function searchSessions(query: string, cwd?: string): Promise<SessionSearchResults> {
  try {
    return await invoke<SessionSearchResults>("search_sessions", { cwd, query });
  } catch (e) {
    normalizeError(e);
  }
}

/** Live `claude` sessions (interactive + background) via `claude agents --json`;
 *  `includeCompleted` adds `--all`. Read-only. (Phase 9.) */
export async function listAgents(includeCompleted = false): Promise<AgentSession[]> {
  try {
    return await invoke<AgentSession[]>("list_agents", { includeCompleted });
  } catch (e) {
    normalizeError(e);
  }
}

/** Transient-daemon status (running? supervisor pid, worker count). Read-only. */
export async function daemonStatus(): Promise<DaemonStatus> {
  try {
    return await invoke<DaemonStatus>("daemon_status");
  } catch (e) {
    normalizeError(e);
  }
}
