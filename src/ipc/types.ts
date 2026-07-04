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

/** Mirror of Rust `AuthStatus` (Addendum II §S2.5) — `claude auth status --json`.
 *  Every field but `loggedIn` is optional (tolerant of a logged-out response,
 *  or a future CLI, omitting some of them). */
export interface AuthStatus {
  loggedIn: boolean;
  authMethod: string | null;
  apiProvider: string | null;
  email: string | null;
  orgId: string | null;
  orgName: string | null;
  subscriptionType: string | null;
}

/** Mirror of Rust `PerfStats` (spec 2.7). */
export interface PerfStats {
  coldStartMs: number | null;
  rssBytes: number;
  rssMb: number;
}

/** Mirror of Rust `Usage` (spec 2.3). `cache_read_input_tokens` +
 *  `cache_creation_input_tokens` dominate true context size on a long
 *  session — `input_tokens` alone badly undercounts it (Addendum III §S9). */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
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

/** The `permissions.defaultMode` values the CLI accepts (Phase 7 7B). */
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

/** Mirror of Rust `ProjectPermissions` (Phase 7 7B) — the modelled slice of the
 *  project's `.claude/settings.json` permissions block. */
export interface ProjectPermissions {
  allow: string[];
  ask: string[];
  deny: string[];
  /** Omitted when unset (the CLI then applies its own default). */
  defaultMode?: PermissionMode;
  additionalDirectories: string[];
}

/** Mirror of Rust `ProjectPermissionsFile` (Phase 7 7B). `exists` is false when
 *  `.claude/settings.json` hasn't been created yet (Save will create it). */
export interface ProjectPermissionsFile {
  exists: boolean;
  permissions: ProjectPermissions;
}

/** Mirror of Rust `AgentDef` (Addendum II §S8) — a project-scoped custom
 *  sub-agent definition (`.claude/agents/<slug>.md`). Project-only for now;
 *  the user-global `~/.claude/agents/` directory is a later phase. */
export interface AgentDef {
  slug: string;
  description: string;
  /** Empty = the CLI inherits all built-in tools. */
  tools: string[];
  /** Empty = the CLI inherits the session's default model. */
  model: string;
  prompt: string;
}

/** Mirror of Rust `AgentDefSummary` — the list-view row. */
export interface AgentDefSummary {
  slug: string;
  description: string;
  tools: string[];
  model: string;
}

/** Mirror of Rust `PluginEntry` (Addendum III §S11) — one row from `claude
 *  plugin list --json`. A skill shows up here too, with `id` ending in
 *  `@skills-dir`. Every field optional: a faithful, uninterpreted mirror. */
export interface PluginEntry {
  id: string | null;
  version: string | null;
  scope: string | null;
  enabled: boolean | null;
  installPath: string | null;
}

/** Mirror of Rust `MarketplaceEntry` — one row from `claude plugin
 *  marketplace list --json`. */
export interface MarketplaceEntry {
  name: string | null;
  source: string | null;
  repo: string | null;
  url: string | null;
  path: string | null;
  installLocation: string | null;
}

/** Mirror of Rust `AvailablePlugin` (Addendum III §S14) — one installable
 *  plugin read from a marketplace's manifest (the CLI has no "list available"
 *  command). Install runs `claude plugin install name@marketplace`. */
export interface AvailablePlugin {
  name: string | null;
  description: string | null;
  category: string | null;
  author: string | null;
  marketplace: string | null;
}

/** Mirror of Rust `McpServerEntry` (Addendum III §S12) — one row parsed from
 *  `claude mcp list`'s human-readable output (no `--json` exists for it, so
 *  `status` is the CLI's own text verbatim, never re-worded). */
export interface McpServerEntry {
  name: string;
  target: string;
  transport: string | null;
  status: string;
}

/** Mirror of Rust `HealthBand` (Addendum III §S13). */
export type HealthBand = "healthy" | "warning" | "critical";

/** Mirror of Rust `MemoryFile` — one topic file under the memory dir. */
export interface MemoryFile {
  name: string;
  lines: number;
}

/** Mirror of Rust `MemoryHealth` (Addendum III §S13) — a read-only report on
 *  Claude's own auto-memory system for this workspace (`~/.claude/projects/
 *  <project>/memory/`), mirroring the `/si:status` skill's own numbers. */
export interface MemoryHealth {
  projectFound: boolean;
  memoryDirExists: boolean;
  memoryMdLines: number;
  memoryMdCap: number;
  memoryMdUpdatedMs: number | null;
  topicFiles: MemoryFile[];
  projectClaudeMdLines: number | null;
  userClaudeMdLines: number | null;
  rulesFileCount: number;
  staleRefs: string[];
  duplicateRefs: string[];
  capacity: HealthBand;
  recommendations: string[];
}

/** The `editor.wordWrap` values Monaco understands (Addendum II §1). */
export type WordWrap = "off" | "on" | "wordWrapColumn" | "bounded";

/** The `editor.autoSave` values the frontend understands (Addendum II §1.2, S2). */
export type AutoSave = "off" | "afterDelay" | "onFocusChange" | "onWindowChange";

/** Mirror of Rust `EditorSettings` (Addendum II §1) — the IDE's own editor
 *  preferences. Every field is optional: present = an explicit override, absent
 *  = fall through to the lower scope or the frontend default. */
export interface EditorSettings {
  fontFamily?: string;
  fontSize?: number;
  fontLigatures?: boolean;
  wordWrap?: WordWrap;
  wordWrapColumn?: number;
  tabSize?: number;
  insertSpaces?: boolean;
  minimap?: boolean;
  formatOnSave?: boolean;
  formatOnPaste?: boolean;
  trimTrailingWhitespace?: boolean;
  insertFinalNewline?: boolean;
  trimFinalNewlines?: boolean;
  autoSave?: AutoSave;
  autoSaveDelay?: number;
}

/** Mirror of Rust `TerminalSettings` (Addendum II §S6). Independent of the
 *  editor's own font settings. */
export interface TerminalSettings {
  fontFamily?: string;
  fontSize?: number;
  cursorBlink?: boolean;
  /** Scrollback buffer size, in lines. */
  scrollback?: number;
}

/** The `files.eol` values the frontend understands (Addendum II §S6). */
export type Eol = "auto" | "lf" | "crlf";

/** Mirror of Rust `FilesSettings` (Addendum II §S6). */
export interface FilesSettings {
  /** Folder/file NAMES excluded from the explorer, search, and Quick Open —
   *  matched by exact path-component name, not a full glob. */
  exclude?: string[];
  eol?: Eol;
  confirmCloseUnsaved?: boolean;
}

/** Mirror of Rust `AppearanceSettings` (Addendum II §S6). Theme itself stays
 *  in `store/theme.ts`, outside the staged-Apply settings model. */
export interface AppearanceSettings {
  colorFileIcons?: boolean;
  reducedMotion?: boolean;
}

/** Mirror of Rust `Attachment` (engine.rs) — one composer attachment.
 *  `data` is base64 for image/document, plain text for kind "text". */
export interface Attachment {
  name: string;
  kind: "image" | "document" | "text";
  mediaType: string;
  data: string;
}

/** Providers modelled by the global token store (`tokens.rs`). */
export type TokenProvider = "github" | "huggingface";

/** Mirror of Rust `TokenStatus` — masked presence, never the secret. */
export interface TokenStatus {
  provider: TokenProvider;
  /** null = not stored; otherwise "…" + last 4 chars. */
  masked: string | null;
  /** The env var is already set outside the app; stored token won't override it. */
  envOverridden: boolean;
}

/** Mirror of Rust `ScopeSettings` — one scope's settings, every category. */
export interface ScopeSettings {
  editor: EditorSettings;
  terminal: TerminalSettings;
  files: FilesSettings;
  appearance: AppearanceSettings;
}

/** Command id -> combo string (e.g. "mod+shift+x"). Always user-global —
 *  never per-workspace (Addendum II §S6). */
export type Keybindings = Record<string, string>;

/** Mirror of Rust `SettingsDoc` — the whole settings document: the global `user`
 *  scope, per-workspace overrides keyed by canonical path, and keybinding
 *  overrides. */
export interface SettingsDoc {
  user: ScopeSettings;
  workspaces: Record<string, ScopeSettings>;
  keybindings: Keybindings;
}

/** Which scope a settings write targets (Addendum II §1). */
export type SettingsScope = "user" | "workspace";

/** Mirror of Rust `TokenSums` (P4, Phase 8) — exact token counts from transcripts. */
export interface TokenSums {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** Assistant messages that carried a usage block. */
  messages: number;
}

/** Mirror of Rust `UsageRow` (P4) — one session's usage. */
export interface UsageRow {
  sessionId: string;
  label: string;
  models: string[];
  lastActiveMs: number;
  tokens: TokenSums;
}

/** Mirror of Rust `UsageReport` (P4) — per-session + total token usage. */
export interface UsageReport {
  rows: UsageRow[];
  totals: TokenSums;
  sessionCount: number;
}

/** Mirror of Rust `SessionHit` (P5, Phase 8) — one matched message snippet. */
export interface SessionHit {
  role: "user" | "assistant";
  snippet: string;
}

/** Mirror of Rust `SessionSearchGroup` (P5) — one session's matches. */
export interface SessionSearchGroup {
  sessionId: string;
  label: string;
  lastActiveMs: number;
  /** Total matching messages (may exceed `hits.length`). */
  hitCount: number;
  hits: SessionHit[];
}

/** Mirror of Rust `SessionSearchResults` (P5) — cross-session search results. */
export interface SessionSearchResults {
  groups: SessionSearchGroup[];
  totalHits: number;
  truncated: boolean;
}

/** Mirror of Rust `AgentSession` (Phase 9) — one live `claude` session from
 *  `claude agents --json`. All fields optional (tolerant of CLI schema drift). */
export interface AgentSession {
  pid?: number;
  cwd?: string;
  /** "interactive" | "background" | … */
  kind?: string;
  sessionId?: string;
  /** Epoch ms. */
  startedAt?: number;
  /** "busy" | "idle" | … (the CLI's own status). */
  status?: string;
}

/** Mirror of Rust `DaemonStatus` (Phase 9) — transient-daemon state. */
export interface DaemonStatus {
  running: boolean;
  supervisorPid?: number;
  workerCount: number;
  updatedAt?: number;
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
      /** CLI summary text — on an error result, often the only explanation. */
      result: string | null;
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
  | { type: "line_truncated"; limit: number }
  | { type: "unknown"; kind: string }
  /** A system/status event with an unmodeled schema, captured RAW instead of
   *  discarded (Addendum III §S10, capture-first — see `rawLog`/Output-Logs
   *  tab). `rate_limit_event` is the target; no field here is interpreted or
   *  surfaced as a fact anywhere yet, only logged for future inspection. */
  | { type: "raw_system_event"; kind: string; raw: unknown };

/** Type guard for errors thrown by the invoke wrappers. */
export function isIpcError(value: unknown): value is IpcError {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "message" in value
  );
}
