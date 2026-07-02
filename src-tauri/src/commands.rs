//! IPC command surface (frontend -> backend).
//!
//! Every command is `async`, returns `Result<T, IpcError>`, and validates its
//! inputs at the boundary (spec 2.4). Phase 0 exposes environment preflight and
//! perf; Phase 1 adds the workspace engine session — open a persistent `claude`
//! session, write turns, interrupt, and close it cleanly. The PTY commands
//! arrive with their phases.

use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;

use crate::agent_defs::{AgentDef, AgentDefSummary};
use crate::agents::{AgentSession, DaemonStatus};
use crate::auth::AuthStatus;
use crate::checkpoints::{CheckpointDiff, CheckpointTimeline};
use crate::engine::{EngineEvent, WorkspaceRegistry};
use crate::error::{IpcError, IpcErrorKind, IpcResult};
use crate::files::{DirEntry, FileContents};
use crate::git::{GitBranches, GitDiff, GitStatus};
use crate::perf::{self, PerfStats};
use crate::permissions::{ProjectPermissions, ProjectPermissionsFile};
use crate::mcp::McpServerEntry;
use crate::memory::MemoryHealth;
use crate::plugins::{AvailablePlugin, MarketplaceEntry, PluginEntry};
use crate::preflight::{self, PreflightReport};
use crate::pty::PtyRegistry;
use crate::search::SearchResults;
use crate::session_search::SessionSearchResults;
use crate::settings::{Scope, ScopeSettings, SettingsDoc};
use crate::sessions::{SessionMeta, SessionTranscript, SessionsRegistry};
use crate::state::AppState;
use crate::usage::UsageReport;

/// Upper bound on a single prompt (defensive; treats prompt strictly as data).
const MAX_PROMPT_LEN: usize = 100_000;

/// Probe the installed `claude` CLI: presence, version, auth (spec 3.10).
#[tauri::command]
pub async fn preflight() -> IpcResult<PreflightReport> {
    preflight::run().await
}

/// Account status (Addendum II §S2.5): `claude auth status --json`, read-only.
#[tauri::command]
pub async fn auth_status() -> IpcResult<AuthStatus> {
    crate::auth::status().await
}

/// Sign out (Addendum II §S2.5): `claude auth logout`, non-interactive.
/// Signing IN runs inside the terminal drawer instead (see `pty_open`) since
/// it's an interactive browser/OAuth flow the CLI owns.
#[tauri::command]
pub async fn auth_logout() -> IpcResult<()> {
    crate::auth::logout().await
}

/// Called once by the frontend on first paint to anchor the cold-start budget.
/// Returns the recorded cold-start time in milliseconds.
#[tauri::command]
pub fn report_ready(state: State<'_, AppState>) -> IpcResult<u64> {
    let ms = state.record_cold_start();
    tracing::info!(cold_start_ms = ms, "ui reported ready");
    perf::mark_cold_start(ms);
    Ok(ms)
}

/// Current perf snapshot (cold start + RSS) for the dev-only perf readout.
#[tauri::command]
pub fn perf_stats(state: State<'_, AppState>) -> IpcResult<PerfStats> {
    Ok(perf::stats(state.cold_start_ms()))
}

/// The default workspace root (canonical absolute path) the app should seed its
/// first tab with — the launch / `CLAUDE_IDE_WORKSPACE` directory (spec 3.2).
/// The frontend "Open Folder…" picker adds further workspaces beyond this one.
#[tauri::command]
pub fn default_workspace() -> IpcResult<String> {
    let path = crate::workspace::resolve_cwd(None)?;
    let path = std::fs::canonicalize(&path).unwrap_or(path);
    Ok(path.to_string_lossy().into_owned())
}

/// Open a persistent `claude` engine session. Every event for the session
/// streams back over `on_event`; returns the workspace id used by the other
/// engine commands. `cwd` defaults to the launch directory (picker is Phase 4).
#[tauri::command]
pub async fn open_workspace(
    cwd: Option<String>,
    model: Option<String>,
    on_event: Channel<EngineEvent>,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> IpcResult<String> {
    registry.open(cwd, model, on_event).await
}

/// Send one turn into a workspace session. Prompt text is treated strictly as
/// data (spec 2.4); responses arrive over the session's `on_event` channel.
#[tauri::command]
pub async fn engine_send(
    workspace_id: String,
    prompt: String,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> IpcResult<()> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(IpcError::new(IpcErrorKind::InvalidInput, "Prompt is empty"));
    }
    if prompt.len() > MAX_PROMPT_LEN {
        return Err(IpcError::new(
            IpcErrorKind::InvalidInput,
            "Prompt exceeds the maximum length",
        ));
    }
    registry.send(&workspace_id, prompt).await
}

/// Interrupt the in-flight turn in a workspace (resolves to a clean `Stopped`;
/// the session itself survives).
#[tauri::command]
pub async fn engine_cancel(
    workspace_id: String,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> IpcResult<()> {
    registry.cancel(&workspace_id).await
}

/// Answer a pending permission request (P1 change-review queue, spec 3.6).
/// `decision` is "allow" or "deny". On allow, `updated_input` is the tool input
/// to run — the original proposed input, or the user's edited version ("Edit").
/// On deny, `message` is the reason shown to the agent. Echoes `request_id` back
/// to the CLI over the control protocol.
#[tauri::command]
pub async fn approve_permission(
    workspace_id: String,
    request_id: String,
    decision: String,
    updated_input: Option<serde_json::Value>,
    message: Option<String>,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> IpcResult<()> {
    let allow = match decision.as_str() {
        "allow" => true,
        "deny" => false,
        _ => {
            return Err(IpcError::new(
                IpcErrorKind::InvalidInput,
                "decision must be \"allow\" or \"deny\"",
            ))
        }
    };
    registry
        .resolve_permission(&workspace_id, &request_id, allow, updated_input, message)
        .await
}

/// Open a session that resumes an existing `claude` conversation by id
/// (`--resume`), or forks it into a new branch (`--fork-session`). Events stream
/// over `on_event`; returns the new workspace id. History is loaded separately
/// via `read_session` (the resume stream does not replay prior turns).
#[tauri::command]
pub async fn resume_workspace(
    cwd: Option<String>,
    session_id: String,
    fork: bool,
    model: Option<String>,
    on_event: Channel<EngineEvent>,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> IpcResult<String> {
    registry.open_with(cwd, Some(session_id), fork, model, on_event).await
}

/// Read a past session's transcript into renderable conversation items so a
/// resumed session shows its full history. Read-only.
#[tauri::command]
pub fn read_session(cwd: Option<String>, session_id: String) -> IpcResult<SessionTranscript> {
    crate::sessions::read_transcript(cwd, &session_id)
}

/// Close a workspace session, reaping the child with no zombie (spec 2.5).
#[tauri::command]
pub async fn close_workspace(
    workspace_id: String,
    registry: State<'_, Arc<WorkspaceRegistry>>,
) -> IpcResult<()> {
    registry.close(&workspace_id).await
}

// ----- Terminal drawer PTY (spec 5.A.6) --------------------------------------
// Sync commands: each does a quick, non-blocking PTY syscall (the blocking
// reads run on a dedicated thread in `pty.rs`). Raw output streams over the
// `on_data` channel.

/// Open a plain shell in a PTY sized `rows`x`cols`, rooted at the workspace
/// `cwd` (None = default workspace); output streams over `on_data`.
#[tauri::command]
pub fn pty_open(
    cwd: Option<String>,
    rows: u16,
    cols: u16,
    on_data: Channel<Vec<u8>>,
    registry: State<'_, Arc<PtyRegistry>>,
) -> IpcResult<String> {
    registry.inner().clone().open(cwd, rows, cols, on_data)
}

/// Write keystrokes into a terminal (treated strictly as bytes for the shell).
#[tauri::command]
pub fn pty_write(
    pty_id: String,
    data: String,
    registry: State<'_, Arc<PtyRegistry>>,
) -> IpcResult<()> {
    registry.write(&pty_id, data.as_bytes())
}

/// Resize a terminal's PTY to match the drawer.
#[tauri::command]
pub fn pty_resize(
    pty_id: String,
    rows: u16,
    cols: u16,
    registry: State<'_, Arc<PtyRegistry>>,
) -> IpcResult<()> {
    registry.resize(&pty_id, rows, cols)
}

/// Close a terminal, reaping its shell with no zombie (spec 5.A.6).
#[tauri::command]
pub fn pty_close(pty_id: String, registry: State<'_, Arc<PtyRegistry>>) -> IpcResult<()> {
    registry.close(&pty_id)
}

// ----- Sessions rail (spec 3.2, 3.3) -----------------------------------------

/// List the workspace's `claude` sessions (read-only), newest activity first.
/// Populates the rail **on open** with no forced turn (spec 3.2).
#[tauri::command]
pub fn list_sessions(cwd: Option<String>) -> IpcResult<Vec<SessionMeta>> {
    crate::sessions::list(cwd)
}

/// Watch `~/.claude/projects/` so a newly-created session appears in the rail
/// live (spec 3.2). The refreshed list streams over `on_change`.
#[tauri::command]
pub fn watch_sessions(
    cwd: Option<String>,
    on_change: Channel<Vec<SessionMeta>>,
    registry: State<'_, Arc<SessionsRegistry>>,
) -> IpcResult<()> {
    registry.watch(cwd, on_change)
}

// ----- Checkpoint timeline (spec 5.P2, Phase 7) ------------------------------
// Read-only: the CLI exposes no programmatic rewind, so we surface its file
// history as a timeline + snapshot-vs-current diff. We never modify it.

/// A session's checkpoint timeline (file-history snapshots), newest first.
#[tauri::command]
pub fn checkpoint_timeline(
    cwd: Option<String>,
    session_id: String,
) -> IpcResult<CheckpointTimeline> {
    crate::checkpoints::timeline(cwd, &session_id)
}

/// Snapshot-vs-current preview for one checkpoint (read-only; no restore).
#[tauri::command]
pub fn checkpoint_diff(
    cwd: Option<String>,
    session_id: String,
    path: String,
    version: u32,
) -> IpcResult<CheckpointDiff> {
    crate::checkpoints::diff(cwd, &session_id, &path, version)
}

// ----- Usage dashboard (P4, Phase 8) -----------------------------------------
// Read-only: exact token sums from the transcripts (the CLI persists no cost).

/// Per-session + total token usage for the workspace (input/output/cache),
/// newest-active first. Read-only; never touches `~/.claude`.
#[tauri::command]
pub fn workspace_usage(cwd: Option<String>) -> IpcResult<UsageReport> {
    crate::usage::workspace_usage(cwd)
}

// ----- Editor file surface (spec 5.A.3, Phase 4) -----------------------------
// Both confined to the workspace root in `files.rs`.

/// List a workspace directory for the file explorer (dirs first, lazy). `cwd`
/// selects the workspace root (None = default); `path` is relative to it.
#[tauri::command]
pub fn list_dir(cwd: Option<String>, path: Option<String>) -> IpcResult<Vec<DirEntry>> {
    crate::files::list_dir(cwd, path)
}

/// Read a workspace file for the editor (UTF-8 text, size-capped, binary-guarded).
#[tauri::command]
pub fn read_file(cwd: Option<String>, path: String) -> IpcResult<FileContents> {
    crate::files::read_file(cwd, path)
}

/// Save (overwrite) an existing workspace file. Confined to the workspace root.
#[tauri::command]
pub fn write_file(cwd: Option<String>, path: String, contents: String) -> IpcResult<()> {
    crate::files::write_file(cwd, path, contents)
}

/// Create a new empty file or folder (Addendum II §S7). `parent` is an existing
/// directory relative to the workspace root (empty = the root); `name` is
/// validated as a single path component. Canonicalize-parent-and-contain, never
/// the not-yet-existing target — see `files::resolve_within`'s SECURITY note.
#[tauri::command]
pub fn create_entry(
    cwd: Option<String>,
    parent: String,
    name: String,
    is_dir: bool,
) -> IpcResult<DirEntry> {
    crate::files::create_entry(cwd, parent, name, is_dir)
}

/// Duplicate an existing workspace file next to itself, auto-numbering the name
/// (Addendum II §S7). Confined to the workspace root.
#[tauri::command]
pub fn duplicate_file(cwd: Option<String>, path: String) -> IpcResult<DirEntry> {
    crate::files::duplicate_file(cwd, path)
}

/// Reveal a workspace file/folder in the OS file manager (Addendum II §S7).
/// `tauri_plugin_opener::reveal_item_in_dir` is used as a plain library
/// function here — never registered as a plugin, never exposed to the webview
/// as its own IPC command — so the ONLY path this can ever act on is one that
/// just passed `files::workspace_path`'s canonicalize-and-contain check. No new
/// capability grant needed: this command is a normal app command like every
/// other one already in this file, not a plugin-provided one.
#[tauri::command]
pub fn reveal_in_file_manager(cwd: Option<String>, path: String) -> IpcResult<()> {
    let target = crate::files::workspace_path(cwd, &path)?;
    tauri_plugin_opener::reveal_item_in_dir(&target)
        .map_err(|e| IpcError::new(IpcErrorKind::Internal, format!("Could not open the file manager: {e}")))
}

// ----- Project permissions (P3 permission manager, spec 3.6, Phase 7 7B) -----
// Read/write the SHARED `.claude/settings.json` permissions block — the file the
// CLI itself reads. The CLI remains the real boundary; this only edits its config.

/// Read the project's `.claude/settings.json` permissions (allow/ask/deny,
/// defaultMode, additionalDirectories) + whether the file exists yet. Read-only.
#[tauri::command]
pub fn read_permissions(cwd: Option<String>) -> IpcResult<ProjectPermissionsFile> {
    crate::permissions::read(cwd)
}

/// Write the project's permissions block, preserving every other settings key
/// (read-modify-write). Creates `.claude/settings.json` if absent. Validated at
/// the boundary (mode enum, rule trimming/dedup, bounds).
#[tauri::command]
pub fn write_permissions(cwd: Option<String>, permissions: ProjectPermissions) -> IpcResult<()> {
    crate::permissions::write(cwd, permissions)
}

// ----- Agent definitions (Addendum II §S8, project-scoped only) --------------
// Author/edit/delete `.claude/agents/*.md` custom sub-agent files — the CLI's
// own format. Distinct from `list_agents`/`daemon_status` above, which report
// LIVE/background `claude` sessions via `claude agents --json`, not definitions.

/// List every agent definition in the project's `.claude/agents/`.
#[tauri::command]
pub fn list_agent_defs(cwd: Option<String>) -> IpcResult<Vec<AgentDefSummary>> {
    crate::agent_defs::list(cwd)
}

/// Read one agent definition's full contents (frontmatter + prompt body).
#[tauri::command]
pub fn read_agent_def(cwd: Option<String>, slug: String) -> IpcResult<AgentDef> {
    crate::agent_defs::read(cwd, slug)
}

/// Create a new agent definition; fails if the name is already taken.
#[tauri::command]
pub fn create_agent_def(cwd: Option<String>, def: AgentDef) -> IpcResult<AgentDefSummary> {
    crate::agent_defs::create(cwd, def)
}

/// Overwrite (or rename, by changing the slug) an existing agent definition.
#[tauri::command]
pub fn update_agent_def(cwd: Option<String>, slug: String, def: AgentDef) -> IpcResult<AgentDefSummary> {
    crate::agent_defs::update(cwd, slug, def)
}

/// Delete an agent definition.
#[tauri::command]
pub fn delete_agent_def(cwd: Option<String>, slug: String) -> IpcResult<()> {
    crate::agent_defs::delete(cwd, slug)
}

// ----- Plugins & Skills (Addendum III §S11) -----------------------------------
// Read-only status for Settings, mirroring `claude plugin list --json` /
// `claude plugin marketplace list --json`. Every mutating action (install,
// enable/disable, uninstall, add a marketplace, scaffold a skill) runs the
// CLI's own command through `InlineTerminal` on the frontend, not here.

/// List installed plugins (and skills — the CLI reports both together).
#[tauri::command]
pub async fn list_plugins() -> IpcResult<Vec<PluginEntry>> {
    crate::plugins::list_plugins().await
}

/// List configured plugin marketplaces.
#[tauri::command]
pub async fn list_marketplaces() -> IpcResult<Vec<MarketplaceEntry>> {
    crate::plugins::list_marketplaces().await
}

/// List installable plugins across configured marketplaces (read from each
/// marketplace's manifest — the CLI has no "list available" command). Install
/// still runs `claude plugin install` through InlineTerminal on the frontend.
#[tauri::command]
pub async fn list_available_plugins() -> IpcResult<Vec<AvailablePlugin>> {
    crate::plugins::list_available_plugins().await
}

// ----- MCP servers (Addendum III §S12) ----------------------------------------
// Read-only status for Settings, parsed from `claude mcp list`'s human-
// readable output (it has no `--json`, unlike `claude plugin list`). Every
// mutating action (add, remove, login, logout) runs the CLI's own command
// through `InlineTerminal` on the frontend, not here.

/// List configured MCP servers (health-checks each one, so this can take a
/// moment — the CLI's own behavior, not something this command adds).
#[tauri::command]
pub async fn list_mcp_servers() -> IpcResult<Vec<McpServerEntry>> {
    crate::mcp::list_mcp_servers().await
}

// ----- Memory health dashboard (Addendum III §S13) ---------------------------
// Read-only: reports on `~/.claude/projects/<project>/memory/` for this
// workspace, mirroring the `/si:status` skill's own numbers. Never writes.

#[tauri::command]
pub fn memory_health(cwd: Option<String>) -> IpcResult<MemoryHealth> {
    crate::memory::memory_health(cwd)
}

// ----- App settings (Addendum II §1, S1) -------------------------------------
// The IDE's OWN preferences (editor font/wrap/tabs/minimap, …), persisted to the
// app's `app_config_dir/settings.json` — NEVER `~/.claude`. Both commands take
// the fixed config dir (resolved here from the AppHandle), no caller path: a
// write can't escape it (§5.1 / §5.8). Values are validated/clamped in settings.rs.

/// Resolve the app's per-user config directory (where `settings.json` lives).
fn app_config_dir(app: &tauri::AppHandle) -> IpcResult<std::path::PathBuf> {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .map_err(|e| IpcError::new(IpcErrorKind::Internal, format!("No config directory: {e}")))
}

/// Read the whole settings document (global `user` scope + per-workspace
/// overrides). Read-only; tolerant of a missing file. The frontend merges scopes.
#[tauri::command]
pub fn read_settings(app: tauri::AppHandle) -> IpcResult<SettingsDoc> {
    crate::settings::read(&app_config_dir(&app)?)
}

/// Write one scope's settings — every category at once (read-modify-write;
/// preserves every other key). `scope` is "user" or "workspace"; for
/// "workspace", `workspace_key` is the workspace's canonical path (used only
/// as a map key). Validated/clamped.
#[tauri::command]
pub fn write_settings(
    app: tauri::AppHandle,
    scope: String,
    workspace_key: Option<String>,
    settings: ScopeSettings,
) -> IpcResult<()> {
    let scope = match scope.as_str() {
        "user" => Scope::User,
        "workspace" => match workspace_key {
            Some(key) => Scope::Workspace(key),
            None => {
                return Err(IpcError::new(
                    IpcErrorKind::InvalidInput,
                    "workspace scope requires a workspaceKey",
                ))
            }
        },
        _ => {
            return Err(IpcError::new(
                IpcErrorKind::InvalidInput,
                "scope must be \"user\" or \"workspace\"",
            ))
        }
    };
    crate::settings::write(&app_config_dir(&app)?, scope, settings)
}

/// Replace the whole keybinding-override map (command id -> combo string),
/// user-global only (Addendum II §S6). Validated/bounded.
#[tauri::command]
pub fn write_keybindings(
    app: tauri::AppHandle,
    overrides: std::collections::BTreeMap<String, String>,
) -> IpcResult<()> {
    crate::settings::write_keybindings(&app_config_dir(&app)?, overrides)
}

// ----- Git source control (spec 5.A.3, Phase 4) ------------------------------
// Read-only slice: status + per-file diff by driving the installed `git` CLI in
// the workspace root. No mutating or destructive command runs here.

/// Working-tree status (staged / unstaged / untracked / conflicted) + branch.
#[tauri::command]
pub fn git_status(cwd: Option<String>) -> IpcResult<GitStatus> {
    crate::git::status(cwd)
}

/// Both sides of one file's diff for the diff editor (HEAD→index when `staged`,
/// else index→working tree).
#[tauri::command]
pub fn git_diff(cwd: Option<String>, path: String, staged: bool) -> IpcResult<GitDiff> {
    crate::git::diff(cwd, path, staged)
}

/// Stage one path (modification / addition / deletion). Non-destructive.
#[tauri::command]
pub fn git_stage(cwd: Option<String>, path: String) -> IpcResult<()> {
    crate::git::stage(cwd, path)
}

/// Unstage one path (working tree untouched). Non-destructive.
#[tauri::command]
pub fn git_unstage(cwd: Option<String>, path: String) -> IpcResult<()> {
    crate::git::unstage(cwd, path)
}

/// Stage every change (incl. untracked + deletions). Non-destructive.
#[tauri::command]
pub fn git_stage_all(cwd: Option<String>) -> IpcResult<()> {
    crate::git::stage_all(cwd)
}

/// Unstage everything (reset index to HEAD; working tree untouched). Non-destructive.
#[tauri::command]
pub fn git_unstage_all(cwd: Option<String>) -> IpcResult<()> {
    crate::git::unstage_all(cwd)
}

/// Commit the staged changes with `message`; returns git's summary line.
#[tauri::command]
pub fn git_commit(cwd: Option<String>, message: String) -> IpcResult<String> {
    crate::git::commit(cwd, message)
}

/// Local branches + the current one, for the branch switcher.
#[tauri::command]
pub fn git_branches(cwd: Option<String>) -> IpcResult<GitBranches> {
    crate::git::branches(cwd)
}

/// Switch to an existing local branch. Non-destructive (git refuses if it would
/// overwrite uncommitted changes; the error surfaces to the UI).
#[tauri::command]
pub fn git_switch_branch(cwd: Option<String>, name: String) -> IpcResult<()> {
    crate::git::switch_branch(cwd, name)
}

/// Create a new branch from HEAD and switch to it. Non-destructive.
#[tauri::command]
pub fn git_create_branch(cwd: Option<String>, name: String) -> IpcResult<()> {
    crate::git::create_branch(cwd, name)
}

/// Discard a single path's working-tree changes — DESTRUCTIVE and irreversible.
/// The frontend gates this behind an explicit confirm dialog (spec: no
/// destructive op without confirmation).
#[tauri::command]
pub fn git_discard(cwd: Option<String>, path: String) -> IpcResult<()> {
    crate::git::discard(cwd, path)
}

// ----- Global search (spec 5.A.3, Phase 4) -----------------------------------

/// Workspace-wide literal search via ripgrep, grouped by file. Read-only.
/// `exclude` is the effective `files.exclude` setting (plain names, Addendum
/// II §S6) — an empty vec searches everything `.gitignore` doesn't already skip.
#[tauri::command]
pub fn search(cwd: Option<String>, query: String, exclude: Vec<String>) -> IpcResult<SearchResults> {
    crate::search::search(cwd, query, exclude)
}

/// Every file in the workspace, respecting `.gitignore` (Quick Open, Addendum
/// II §S3) and `files.exclude` (§S6). Read-only.
#[tauri::command]
pub fn list_files(cwd: Option<String>, exclude: Vec<String>) -> IpcResult<Vec<String>> {
    crate::search::list_files(cwd, exclude)
}

// ----- Cross-session search (P5, Phase 8) ------------------------------------

/// Full-text search across the workspace's `claude` session transcripts (user +
/// assistant message text), grouped by session with snippets. Read-only.
#[tauri::command]
pub fn search_sessions(cwd: Option<String>, query: String) -> IpcResult<SessionSearchResults> {
    crate::session_search::search(cwd, &query)
}

// ----- Agents / parallel sessions + daemon (Phase 9) -------------------------
// Read-only: we surface the CLI's own `claude agents` view and the daemon roster;
// we never manage agents ourselves (the CLI owns that, per the wrapper contract).

/// Live `claude` sessions (interactive + background) via `claude agents --json`.
/// `include_completed` adds `--all`. Read-only.
#[tauri::command]
pub async fn list_agents(include_completed: bool) -> IpcResult<Vec<AgentSession>> {
    crate::agents::list(include_completed).await
}

/// Transient-daemon status from `roster.json` + a supervisor-pid liveness check.
#[tauri::command]
pub fn daemon_status() -> IpcResult<DaemonStatus> {
    crate::agents::daemon_status()
}
