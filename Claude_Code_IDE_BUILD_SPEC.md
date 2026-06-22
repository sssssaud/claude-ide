# Claude Code IDE — Master Build Specification
### A native, agent-first IDE built to stand beside VS Code and Antigravity

**How to use this document.** This is the complete build brief for **Claude Code (the CLI agent)** to implement the IDE. It is written to *acceptance-criteria depth* on purpose: every section tells the builder not only **what** to build, but **what "done" looks like** and **what must never happen**. Paste it into Claude Code; it will start in plan mode and build phase by phase. Facts about the Claude Code CLI in this spec were verified at spec time and carry version notes where relevant — but the installed CLI is always the source of truth (see §1.5).

**Document map**
- **Part 1 — Mission, positioning & operating contract** ← *this part*
- **Part 2 — System architecture** (Tauri/Rust topology, the persistent structured engine, IPC contracts, state model, concurrency, performance budgets) — *reply "continue"*
- **Part 3 — Claude Code integration layer** (the verified "wrap, don't reinvent" contract: sessions, slug paths, daemon/agents, CLI flag surface, permission-prompt tool, stream-json schema, env/settings) — *reply "continue"*
- **Part 4 — Frontend architecture & design system** (visual identity, design tokens, docking, command palette, keyboard model, onboarding/empty/error states, accessibility) — *reply "continue"*
- **Part 5 — Feature specifications** (acceptance-criteria level, incl. the 5 power features) — *reply "continue"*
- **Part 6 — Phased roadmap, definition of done, test & acceptance plan** — *reply "continue"*

---

## Part 1 — Mission, Positioning & Operating Contract

### 1.1 What we are building

A **native desktop IDE that wraps the Claude Code CLI** and makes the **agent loop the center of gravity**, while remaining a real code editor. Stack: **Tauri** (Rust backend, web frontend), **Monaco** (editor, diffs, markdown), **xterm.js** (terminal), driving the `claude` binary. The product is a control surface for running, steering, reviewing, and *trusting* Claude Code's work — with editing, git, and language tooling around it so the developer never has to leave.

### 1.2 Who we stand next to — and how we win (honest positioning)

We are not pretending the field is empty. Here is the real landscape and our wedge against each:

- **VS Code + an AI extension (Cline / Cursor / Copilot).** Mature editor, enormous extension ecosystem — but the agent is a *bolted-on chat panel*. Session history, checkpoints, permission rules, and cost are shallow or invisible; you juggle editor + terminal + a separate agent UI. **Our wedge:** the agent loop is first-class, and we surface the native session / checkpoint / permission / cost machinery these tools bury.

- **Antigravity (Google's agentic IDE).** Strong "agent manager" model, but oriented around Google's models and ecosystem. **Our wedge:** we are built specifically around *Claude Code's actual capabilities* — `stream-json` events, the background-agent daemon, `/rewind`, git worktrees, the permission-prompt tool — and expose them faithfully instead of flattening them into a lowest-common-denominator abstraction.

- **Anthropic's own Claude desktop app.** This already ships a **diff-review view** (file-by-file, click-a-line-to-comment, `+12 −1` indicator) and **parallel git-worktree sessions** and cloud-session launching. **So our wedge is NOT "we add a diff viewer."** It is a *session manager*, not a full editor — no deep Monaco editing, no LSP, no file-tree-centric workflow, no extensible UI. **Our wedge:** be the **full code editor AND the best Claude Code control surface in one app**, unifying what otherwise splits across VS Code + the desktop app + a terminal. We study its diff UX and go further; we do not reinvent it badly.

**The honest part:** we will not out-extension VS Code's ecosystem on day one, and we do not try to. We win by being **the best place to drive Claude Code while editing real code** — calmer, faster, and more trustworthy than stitching three tools together.

### 1.3 The single design principle

**The agent loop is the product.** Every pane, shortcut, token, and animation exists to make running, steering, reviewing, and trusting Claude Code's work faster and calmer. If a proposed feature does not serve that, it is scope creep and is cut.

### 1.4 "Not vibe-coded" — defined operationally

This is the acceptance bar for the whole build. The implementation is **rejected** if any of these are violated:

1. **Acceptance criteria are met, not eyeballed.** Every feature in Part 5 ships with its stated criteria demonstrably satisfied. "Looks done" is not done.
2. **No placeholders in shipped paths.** No `TODO`, no stub functions, no commented-out "later" code, no `unimplemented!()` on a reachable path. Dummy data is permitted *only* in isolated dev harnesses and must be removed before the phase is marked complete.
3. **Performance budgets are measured.** The budgets in Part 2 (cold start, memory, frame time, stream-render latency) are instrumented and met — not assumed.
4. **Every external surface is defended.** Each process spawn, filesystem access, and IPC command has input validation, structured error handling, and an explicit Tauri capability scope. No blanket shell-exec exposed to the frontend.
5. **Every state is designed.** Each view has an intentional *empty*, *loading*, and *error* state (Part 4). No blank panes, no raw stack traces shown to the user, no infinite spinners without a timeout + recovery.
6. **Accessibility baseline is met.** Full keyboard operability, `prefers-reduced-motion` honored, WCAG-AA contrast, focus-visible everywhere (Part 4).
7. **Nothing is hand-rolled that the CLI owns.** Sessions, deletion, checkpoints, permissions, and the background-agent fleet are the CLI's. Part 3 is the binding contract; violating it (e.g. `rm -rf ~/.claude/projects`) is an automatic rejection.

### 1.5 How Claude Code must execute this build (the operating contract)

This section governs *your behavior as the builder*, not just the artifact.

- **Plan mode first.** Before writing any code or creating any file, enter plan mode (`Shift+Tab` / `/plan`), propose the directory map and the Phase 0 plan, and **wait for my explicit confirmation.** Do not scaffold ahead of approval.
- **Build strictly phase by phase** (Part 6). Each phase ends with: a working, demoable result + that phase's acceptance criteria checked off + a git commit. **Stop and show me before starting the next phase.**
- **One concern at a time, tested in isolation before integration.** Dummy data before real `claude` processes; verify a unit works before wiring it to anything else.
- **Run the loop on every non-trivial decision:** state the goal → name what can go wrong → choose the approach (with the cheapest correct option) → implement → **verify against the acceptance criteria** → if it's wrong, **revert and replace the foundation, don't patch over it.**
- **Validate every CLI assumption against the installed binary.** Before relying on any path, flag, command, or output shape, confirm it with `claude --help`, `claude --version`, and `/doctor`. Part 3 records what was true at spec time *with version notes*; the installed CLI wins on any conflict.
- **Definition of done, per task:** code + error handling + the relevant acceptance criteria + a test (or a clearly demonstrable manual verification) + committed to git. "It ran once" is not done.
- **When genuinely unsure, ask — with at most 2–3 options and a clear recommendation.** Never silently guess on architecture or on a CLI behavior you can verify.
- **Keep modules small and concerns separated** so each is testable alone. Minimal but never flimsy: never cut input validation, error handling, security scoping, or accessibility to save effort.

### 1.6 Hard constraints

- **Linux-first.** Pop!_OS is the reference platform (Tauri Linux deps via `apt`). macOS and Windows are goals, not gates — but write cross-platform-safe code (path handling, PTY, process signals) from the start.
- **This is a wrapper.** `claude` owns the agent loop, sessions, permissions, checkpoints, and the background-agent daemon. The IDE **launches, routes, renders, and surfaces** — it never replaces those. Part 3 enumerates exactly what we wrap vs. build.
- **GitHub is the durable backup.** Commit at every working checkpoint; the project must be safe to lose locally at any moment.

---

---

## Part 2 — System Architecture

### 2.1 Three planes (topology)

```
┌───────────────────────── UI PLANE (webview: TypeScript) ─────────────────────────┐
│  Monaco · xterm.js · session sidebar · chat-card pane · command palette · dialogs  │
│  Read-only DERIVED store (mirrors backend state via events + channels)             │
└───────────────▲───────────────────────────────────────────────▲──────────────────┘
                │ invoke(commands)                                │ Channel<T> + emit(events)
┌───────────────┴─────────── ORCHESTRATION PLANE (Rust / Tauri core) ───────────────┐
│  WorkspaceRegistry  ← single source of truth                                       │
│  Engine session (persistent) · Plain-shell terminal                                │
│  SessionReader · FsWatcher (debounced) · Preflight · DaemonBridge                   │
└───────────────▲───────────────────────────────────────────────▲──────────────────┘
                │ spawn / pipe / signal                           │ read-only
┌───────────────┴────────── EXECUTION PLANE (owned by Claude Code) ──────────────────┐
│  `claude -p … --output-format stream-json`  (headless turns)                       │
│  `claude` interactive TUI  (one per workspace, in a PTY)                            │
│  CC background-agent daemon (`claude agents` / `claude daemon`)  ·  ~/.claude/      │
└───────────────────────────────────────────────────────────────────────────────────┘
```

**Rule:** the webview is a *view*. All authoritative state lives in the Orchestration plane. The Execution plane belongs to the CLI — we observe and drive it, never reach into its data structures.

### 2.2 Process model & lifecycle

Per workspace, **one managed engine**, plus an optional unmanaged escape hatch, plus a delegated role:
- **The Engine — persistent structured session (the single managed surface):** **one long-lived** Agent-SDK streaming session per workspace (run as a Tauri-managed **sidecar**), **not** a fresh `claude -p` per turn. Turns are sent into the live session; it emits a structured, id-keyed event stream. This is the *only* surface the IDE renders, drives, and gates permissions on. (Implementation alternative if the sidecar is undesirable: drive the `claude` binary's persistent `--input-format stream-json` mode directly — but the Agent SDK is the documented, robust path.)
- **Raw terminal passthrough (optional, explicitly UNMANAGED):** a plain shell in the drawer by default; the native `claude` TUI may be offered as a passthrough, but when the user is in it the IDE **steps back** — see the boundary rule below. v1 may defer the `claude` passthrough entirely.
- **Background / parallel agents:** **not ours.** Delegated to CC's daemon (Part 3); `DaemonBridge` reads status; the IDE never spawns its own background fleet.

> **Why one persistent engine (this resolves the recurring dual-channel failures).** A single long-lived structured session means: permissions apply uniformly to **all** agent activity (no bypass); there is **one** id-keyed event stream to render (no raw-ANSI to reconcile); there is no full-screen TUI to puppet or detect-idle; and the permission/MCP connection is established **once** at session start, not re-handshaked every turn (so turn-start latency stays low). The earlier "two `claude` processes on one session" concurrency hazard simply cannot occur — there is one engine.

> **Source of truth.** The **engine's structured event stream is the live, authoritative source** for the conversation pane (id-keyed; see §2.3). The session `.jsonl` transcript is the **durable backup and recovery source** — the IDE tails it (appends only) for crash recovery and to catch external changes, **not** as a second concurrent live renderer, so there is no double-render. (If the optional raw passthrough is used, the pane does not mirror it live; on returning to the managed engine the pane reconciles from the transcript — see the boundary rule.)

> **Boundary rule for the optional raw passthrough.** If the user drops into the native `claude` TUI: (1) the IDE does **not** mirror its output in the structured pane (the terminal *is* the interface there); (2) the IDE does **not** inject commands into it (the user types directly); (3) tool approvals use Claude Code's **native** prompts — the IDE's change-review queue is a managed-engine feature, and this boundary is stated plainly in the UI, not a hidden bypass; (4) on exit, the pane rebuilds from the transcript. The managed engine and the raw passthrough are **never both live on the same session at once.**
>
> **Enforce this physically, not by convention.** Claude Code holds a single-process filesystem lock on an active session. So before spawning the passthrough PTY, the backend must **detach/pause the persistent engine sidecar** for that workspace — releasing its session lock — and only **re-initialize/resume** it once the PTY exits. The state machine (below) gates this: the workspace transitions `Idle → Passthrough` (engine paused, lock released) and `Passthrough → Idle` (engine resumed) explicitly, so the two can never contend for the lock.

Workspace process state machine (authoritative in the registry; every transition emits `workspace_state_changed`):
```
Cold ──open──▶ Preflight ──ok──▶ Spawning ──ready──▶ Idle
   ▲                │fail             │fail             │ engine_send
   │                ▼                 ▼                 ▼
 Closed ◀─teardown─ Error ◀──────────┴───────────── Running(turn)
                                                       │ permission event
                                                       ▼
                                                 AwaitingApproval ──decision──▶ Running
```
No implicit states; the UI never guesses status — it reflects the emitted state.

**Handle ownership (fixes a whole bug class):** all `Child` and PTY handles live ONLY in Rust managed state and never cross IPC. The registry owns them; the frontend holds opaque ids.

### 2.3 The engine contract (detailed)

**The managed engine — persistent structured session**
- **Lifetime:** one Agent-SDK streaming session per workspace, started on `open_workspace`, `cwd` locked to the workspace root, torn down on close. Turns are **sent into the live session** (streaming input), not by re-spawning per turn. The permission handler and any IDE-local tools are wired **once** at session start.
- **Streaming:** the session emits a structured event stream; the read loop maps each event into a typed `EngineEvent` (below) by its `type` field — never by position; tolerate unknown variants. **Tee the raw events to a per-session log before parsing** so a parse failure still leaves the bytes. Forward each `EngineEvent` over a `tauri::ipc::Channel<EngineEvent>` (Tauri's streaming-optimized path).
- **Rendering is id-keyed:** every message/turn carries a stable id; the pane renders provisionally from the live stream keyed by id and finalizes the same id on the turn's `Result` (replace, never duplicate). Since there is only one live stream, there is no second renderer to deconflict.
- **Session continuity:** capture `session_id` from the init event; store it on the `WorkspaceInstance`. Resume across app restarts via the SDK's resume option (`--resume <session_id>` equivalent).
- **Permissions are wired once (the change-review queue, P1):** the engine session is started with the permission handler attached — the Agent SDK's `canUseTool` callback (preferred), or `--permission-prompt-tool` against a local MCP server registered once via `--mcp-config` at session start. Either way the handshake happens **at session start, not per turn**, so it adds **no per-turn latency**. The callback calls into the Tauri backend over IPC, surfaces the approval card, and returns allow/deny (+ `updatedInput`). This applies to **every** tool call in the managed engine — no bypass.
- **Slash commands** (branch / rename / clear / rewind) are sent through the **structured input channel** (the SDK accepts them in the input stream) or the equivalent flags (`--fork-session`, `--resume`) — never by puppeting a terminal.
- **Cancellation:** use the SDK's **interrupt** on the live session (graceful), or resolve a pending approval as a deny to end the turn cleanly; a hard process kill is the last resort only (it can leave a partial transcript). Emit a clean `Stopped`. On platforms where a signal is used, Unix = `SIGINT`, Windows = a console control event (limited for piped children) — but the SDK interrupt is the primary path.
- **Backpressure:** coalesce consecutive `AssistantDelta`s if the UI lags, but **never drop** `ToolUse`, `ToolResult`, `PermissionRequest`, or `Result`.

**The optional raw terminal passthrough — UNMANAGED**
- Default drawer content is a **plain shell** (`portable-pty`: `native_pty_system().openpty(PtySize{..})` → `CommandBuilder::new(<user shell>).cwd(root)`; reader thread → `Channel<Vec<u8>>` → xterm.js; `pty_write` for keystrokes; `master.resize(..)` on resize).
- The native `claude` TUI may be offered here as a passthrough, but per the §2.2 boundary rule the IDE **does not mirror, inject into, or apply its change-review queue to it** — `pty_write` carries only the user's own keystrokes, approvals are the CLI's native prompts, and the managed engine is not live on that session while the passthrough is. v1 may defer the `claude` passthrough.

**`EngineEvent` — the typed contract (Rust enum, mirrored 1:1 in TypeScript):**
```rust
enum EngineEvent {
  Init { session_id: String, model: String, slash_commands: Vec<String>, tools: Vec<String> },
  AssistantDelta { text: String },                        // partial token stream
  ToolUse { id: String, name: String, input: serde_json::Value },
  ToolResult { id: String, output: serde_json::Value, is_error: bool },
  PermissionRequest { request_id: String, tool: String, detail: serde_json::Value },
  Result { is_error: bool, total_cost_usd: Option<f64>, usage: Usage, session_id: String },
  Stopped,                                                 // user-cancelled
  ParseError { raw: String },                              // surfaced, never swallowed
  Unknown { kind: String },                                // newer-CLI variant: logged, benign
}
```
The TS mirror is kept in lockstep (one shared schema — hand-mirror or codegen). An unknown `type` from a newer CLI maps to `Unknown`, is logged, and never crashes the pane.

> **One stream, two event origins.** Most `EngineEvent`s come straight from the engine's structured stream. The exception is `PermissionRequest`: it is **raised by the IDE's permission handler** (the SDK `canUseTool` callback, or the local MCP permission server — P1, §3.6), surfaced into the same per-workspace channel the UI consumes; `approve_permission` resolves that pending request. There is no separate concurrent process to reconcile.

### 2.4 IPC contract

**Commands (frontend → backend), each `#[tauri::command] async`, each returns `Result<T, IpcError>`:**

| Command | Input | Returns | Notes |
|---|---|---|---|
| `open_workspace` | `path` | `WorkspaceInstance` | canonicalize, preflight, **start the engine session** + plain terminal |
| `close_workspace` | `id` | `()` | kill B + any running A; remove from registry |
| `engine_send` | `id, prompt, opts, on_event: Channel<EngineEvent>` | `turn_id` | send a turn into the **live engine session**; stream over the channel |
| `engine_cancel` | `id, turn_id` | `()` | SIGINT → kill grace |
| `pty_write` | `id, data` | `()` | keystrokes / slash commands into the PTY |
| `pty_resize` | `id, cols, rows` | `()` | resize the PTY |
| `approve_permission` | `id, request_id, decision` | `()` | P1 — resolves the pending request held by the IDE's local MCP permission server (§3.6); **not** a stdin reply |
| `list_sessions` | `id` | `Vec<SessionMeta>` | read the per-project index file (§3.1) |
| `open_session` | `id, session_id` | `()` | resume (A and/or B) |
| `purge_project` | `id, dry_run` | `PurgePlan` | wrap `claude project purge` (Part 3) — never hand-rolled |
| `daemon_status` | — | `DaemonStatus` | wrap `claude daemon status` |

Every command validates inputs at the boundary (canonicalize paths and require them inside an allowed root; bound numeric args; treat prompt text strictly as data). **Never panic across IPC** — map all failures to a typed `IpcError { kind, message, detail? }`.

**Events vs Channels (per Tauri v2 guidance):**
- **Channels** (`tauri::ipc::Channel<T>`) for the two high-frequency streams — `EngineEvent` (per turn) and PTY bytes (per workspace). *Channels are the streaming-optimized primitive; events are explicitly not for low-latency / high-throughput.*
- **Events** (`emit`) for low-frequency notifications — `workspace_state_changed`, `daemon_status_changed`, `file_changed`, `cost_updated`, `error_toast`.

### 2.5 State & concurrency model

- **Single source of truth:** `WorkspaceRegistry` in Tauri managed state — `Arc<RwLock<HashMap<WorkspaceId, Workspace>>>` (or `DashMap` for finer-grained locking). Holds instance metadata, process handles, current turn, and session binding.
- **Frontend store is derived and read-only** — it never owns truth; it rebuilds from `workspace_state_changed` events + channel streams, and re-queries the backend on reload.
- **Concurrency:** each engine turn and each PTY reader runs on its own async task (`tauri::async_runtime::spawn` / tokio). Reader loops are non-blocking; **no blocking I/O or JSON parsing on the UI thread** — parse in Rust, ship typed events.
- **Isolation:** every spawn is `cwd`-locked and keyed by canonical path (Part 3). No shared global that could bleed one workspace's context into another.
- **Teardown:** closing a tab tears down that workspace's tasks + handles; app exit (`RunEvent::ExitRequested`) tears down *all* children — zero zombies. Monaco/xterm instances are per-tab and disposed on close (no webview leaks).

### 2.6 Error handling & resilience

- **Error layering:** typed Rust errors (`thiserror`) → `IpcError` at the boundary → a user-facing inline state or toast. **Never** show a raw stack trace or panic text: always a plain-language message + a "Details / Copy logs" affordance + a `tracing` log entry.
- **Defined recoveries:** engine died mid-turn → mark the turn failed, offer retry; PTY died → offer restart; `claude` missing / not authed (preflight) → guided fix, don't spawn; daemon unreachable → degrade the agents panel gracefully and surface the `claude daemon status` hint.
- **Crash safety:** all children killed on exit; on next launch, offer to resume the last sessions (`--resume`). The app must be safe to hard-kill at any moment.
- **Observability:** `tracing` structured logs in the backend; a toggleable Debug drawer in the UI showing recent events + the raw-stream tee path. Never log secrets; never duplicate the (already plaintext) transcripts.

### 2.7 Performance budgets (measured, not assumed)

Acceptance gates — each instrumented (timestamps + a dev-only perf panel). A phase is not done until its budgets are measured on the reference machine.

| Metric | Budget (p95) | How measured |
|---|---|---|
| Cold start → interactive window ready | ≤ 1.5 s | process-start ts → first-paint-ready ts |
| Idle RSS (IDE process, excl. child `claude`) | ≤ 250 MB | OS RSS sample at idle (Monaco is the main driver) |
| Engine event → visible in chat (**render** latency) | ≤ 50 ms | emit ts vs DOM-commit ts |
| Turn start → first token (**not** the 50 ms render budget) | ≤ 500 ms typical | Enter ts vs first `AssistantDelta` |
| PTY keystroke → echo | ≤ 16 ms (1 frame) | input ts vs xterm render ts |
| UI frame rate during streaming | ≥ 60 fps sustained | frame timing while a turn streams |
| Open a large session transcript | first content ≤ 300 ms | stream-parse start → first row rendered |

Hard rule behind the budgets: **bulk data stays in Rust; the webview is an I/O surface** (the documented Tauri pattern). Never marshal a whole transcript or a 100k-event blob across IPC at once. **Note on turn-start:** the ≤50 ms budget measures *rendering* an event, not process startup — these are different axes. Turn-start latency is kept low by the **persistent engine** (§2.2): the session and its permission handler are alive between turns, so there is no per-turn spawn or MCP re-handshake.

### 2.8 Security architecture (Tauri capabilities)

- **Least privilege:** the webview can call *only* the enumerated commands. No generic shell-exec; no arbitrary fs command exposed.
- **Capabilities:** scope filesystem *write* to opened workspace roots; allow *read-only* access to `~/.claude/projects` (session listing) and nothing else under `~/.claude`; lock the CSP; serve no remote content.
- **Boundary sanitization:** every path canonicalized and checked to be within an allowed root before use; prompt/command text is data passed to the CLI, never interpolated into a shell string.
- **Deletion guardrail (restated):** project deletion ONLY via `claude project purge --dry-run` → confirm → execute. Never `fs::remove_dir_all` / `rm -rf` on `~/.claude/...`.
- **Secrets:** the IDE stores no credentials; it relies on the CLI's own auth. API keys never touch logs or state.

---

---

## Part 3 — Claude Code Integration Layer

> **Prime directive:** the IDE is a *client of the `claude` binary*. Everything below is the contract for how the IDE talks to it. Facts carry version notes where known; the **installed CLI is always authoritative** (`claude --help`, `claude --version`, `/doctor`). Where this part says "**probe**," the builder must detect the real shape at runtime rather than hardcode it.

### 3.1 On-disk state map (`~/.claude/`)

Config home is `~/.claude/` (relocatable via `CLAUDE_CONFIG_DIR` — but that moves the *whole* home; see §3.10).

| Path | Contents | IDE access |
|---|---|---|
| `~/.claude/projects/<slug>/` | a project's session data | read-only |
| `~/.claude/projects/<slug>/<session-id>.jsonl` | append-only transcript (one JSON object per line) | read on open; **tail the *active* session live** (appends only) |
| `~/.claude/projects/<slug>/` index file | per-project metadata (summaries, message counts, git branch, timestamps) — filename varies by version (e.g. `sessions-index.json`); **probe** | read for the session list |
| `~/.claude/history.jsonl` | global prompt index across all projects | read for cross-session search |
| `~/.claude/jobs/<id>/` | background-job working dirs (`CLAUDE_JOB_DIR`) | leave to the daemon |
| `~/.claude.json` | **auth + project entries (path registry) + local MCP config** | **read-only OK; never delete/modify** |
| `~/.claude/settings.json` | user settings | read/surface, don't delete |
| `~/.claude/plugins/` | installed plugins | **never delete** |
| `.claude/` (in project) | `settings.json`, `CLAUDE.md`, `skills/`, `commands/`, `agents/`, `rules/`, `plans/`, hooks | read/surface |

Notes: transcripts are auto-deleted after `cleanupPeriodDays` (default 30) — so the JSONL is **not** a durable store; rollback is the CLI's job (§3.3). Newer CLI versions may nest transcripts under a `sessions/` subdir — **probe the layout**, don't hardcode.

### 3.2 The project-folder slug rule (exact)

`<slug>` is derived from the project's **absolute cwd** by replacing path separators and other characters the CLI sanitizes (notably `/`, spaces, `~`) with `-` — e.g. `/home/saud/app` → `-home-saud-app`. In the common case it is **not** a hash.

**The IDE must NOT recompute the slug.** It (a) lists `~/.claude/projects/` and matches the directory the CLI actually created, or (b) reads `session_id` from the engine's `Init` event. This sidesteps a real failure mode: a pure separator-replacement breaches the **255-char filename limit** for deeply nested paths (enterprise monorepos), so the CLI may **truncate or hash long paths**. A naive recompute would then produce a folder name the CLI never created and miss the session. The exact long-path behavior is the CLI's — **probe it, never assume** the simple rule holds, and **never invent your own hashing scheme** (it would have to match the CLI's byte-for-byte anyway, which is exactly why reading the directory is mandatory rather than deriving).

**Resolving a freshly-opened path → its sessions on boot (before any turn).** Option (b) alone would leave the sidebar blank until the first turn, and option (a) is ambiguous once paths are truncated/hashed — so neither is sufficient by itself. The reliable source is the CLI's own **project registry in `~/.claude.json`** (read-only; reading is allowed, only modifying is forbidden), which is keyed by absolute project path. On `open_workspace`, read it to confirm the path is a known project and to resolve its session storage, then read that project's index file — populating the Sessions sidebar **immediately, not after a forced headless turn**. If the path→folder mapping isn't directly available from the CLI's records, obtain it from the CLI itself (a cheap session-listing query in that cwd) rather than reversing the lossy slug. **Never bind to a session you can't confidently match** — surface what was found and let the user pick.

**Brand-new directory (never run Claude Code).** The path is absent from the registry and has no sessions — an **empty sidebar is the correct state** (there is nothing to show). It does **not** stay blind until restart: (1) the FsWatcher watches **`~/.claude/projects/` itself** for a *new subdirectory appearing* — this needs **no** slug pre-computation, since the watcher just notices the new entry the CLI creates; and (2) the engine's first `Init` event reports the new `session_id`. Binding those two, the new session appears in the sidebar **live, the moment the first turn runs** — satisfying §1.4.5, no restart, no global poll.

### 3.3 Session actions → exact CLI mechanism

**Delivery (per §2.3):** IDE-initiated actions use the **structured input path** (Agent SDK / `--input-format stream-json`) or the equivalent **CLI flags** — never blind `pty_write` into a live TUI. The user may also type any of these directly in the interactive terminal.

| IDE action | Mechanism | Notes |
|---|---|---|
| List sessions | read the per-project index file (+ `~/.claude.json` registry on boot, §3.2) | not by parsing transcripts |
| Resume | `claude --resume <id>` (or `-c` most-recent, `--session-id <uuid>`) | **scoped to the directory the session started in** (+ git worktrees); run from that cwd |
| Fork on resume | `--fork-session` | new session id instead of reusing the original |
| Resume from PR | `--from-pr <pr>` | session linked to a GitHub PR |
| Rename | `/rename [name]` via structured input (or user-typed in the TUI) | no arg ⇒ auto-name from context |
| Branch | `--fork-session` (headless) or `/branch [name]` via structured input | alias `/fork` (renamed v2.1.77); preserves original |
| Rewind | `/rewind` (alias `/checkpoint`, `Esc+Esc`) — driven from the IDE's checkpoint UI or user-invoked | selective: **code-only / conversation-only / both** |
| Clear | `/clear` via structured input (or user-typed) | resets context, keeps config |
| Export / copy | `/export` (file/clipboard) · `/copy` (last response) | |

### 3.4 Engine flag surface (used by the persistent session)

Verified at spec time; confirm against `claude --help`:
```
claude -p "<prompt>"                     single non-interactive turn, then exit
  --output-format text|json|stream-json  text=prose · json=one final envelope · stream-json=NDJSON events
  --input-format text|stream-json        stream-json (bidirectional) is thinly documented → prefer Agent SDK
  --include-partial-messages             token-delta events (only with stream-json)
  --verbose                              full turn-by-turn output
  --resume <id> | --session-id <uuid>    continuity (see §3.3)
  --fork-session | --from-pr <pr>        fork / PR-linked resume
  --max-turns <N> | --max-budget-usd <X> execution caps (print mode)
  --json-schema '<schema>'               validated output in the `structured_output` field
  --permission-mode <mode>               default|acceptEdits|plan|dontAsk|bypassPermissions
  --permission-prompt-tool <mcp-tool>    route approvals to an MCP tool (§3.6) — the P1 foundation
  --allowedTools|--disallowedTools           static tool gating
  --add-dir|--settings|--setting-sources|--mcp-config|--strict-mcp-config   config inputs
  --model <name>|--fallback-model <name>|--agent <name>|--agents '<json>'    model & agent config
  --append-system-prompt "<text>"        additive system prompt
  --no-session-persistence               utility turns that must NOT pollute history
```
Security note: `-p` **skips the workspace trust dialog** — only run it in directories the user explicitly opened.

### 3.5 The `stream-json` event reference

With `--output-format stream-json --verbose --include-partial-messages`, stdout is NDJSON; **parse each line by its `type` field**, tolerate unknown types, and **tee the raw line before parsing**. Event families the IDE consumes (exact field names vary by version — probe and map defensively):

- **init / system** — `session_id`, `model`, available `slash_commands`, tool surface.
- **assistant / stream_event** — partial message deltas (token streaming).
- **user** — echoed user/tool turns.
- **tool_use** — `id`, tool `name`, `input`.
- **tool_result** — `id`, `output`, `is_error`.
- **permission request** — surfaced via the permission-prompt tool (§3.6), not normally answered via stdin.
- **result** — terminal: `is_error`, `total_cost_usd`, `usage` (input/output/cache tokens), `session_id`, durations; with `--json-schema`, a `structured_output` field.

Map each to the `EngineEvent` enum (Part 2 §2.3).

### 3.6 The permission / approval mechanism (P1 foundation) — verified contract

Claude evaluates a tool call in this order (**deny wins, even in bypass**):
**PreToolUse hooks → `deny` rules → `allow` rules → `ask` rules → `defaultMode`.**

`--permission-prompt-tool <mcp-tool>` plugs in as the **fallback when no static rule matches** (it is *not* called when a rule already decides). When invoked, the IDE's MCP tool receives:
```json
{ "tool_use_id": "<id>", "tool_name": "<Tool>", "input": { /* the tool's input */ } }
```
and must return, in its response text, JSON of one of:
```json
{ "behavior": "allow", "updatedInput": { /* same or EDITED input */ } }
{ "behavior": "deny",  "message": "<reason shown to Claude>" }
```
**This is the architecture for the change-review queue (P1):** the **persistent engine session is started with the permission handler attached, once** (§2.3) — the Agent SDK's `canUseTool` callback (preferred, in-process), or a tiny local MCP server (`mcp__ide__permission_prompt`) registered via `--mcp-config` at session start. When a decision is needed, the handler surfaces the diff/approval UI, **blocks on the user's choice**, and returns the JSON; the optional `updatedInput` lets the user **edit the proposed action** before it runs. The raw `--permission-prompt-tool` flag is undocumented and not in `--help`, so **`canUseTool` is the primary, documented mechanism**.

**Permission rule format (for the P3 manager):**
- `ToolName` or `ToolName(pattern)`. Bash: `Bash(npm run:*)`. **MCP: `mcp__server__tool` (double-underscore, NO parentheses).** Subagents: `Agent(Name)`. Globs: prefix `pre:*` and pattern `*`; **spacing matters** (`Bash(ls *)` ≠ `Bash(ls*)`).
- `defaultMode`: `default | acceptEdits | plan | dontAsk | bypassPermissions` (Shift+Tab cycles).
- Precedence of config files: managed (enterprise) > CLI flags > `.local` (gitignored) > project `.claude/settings.json` > user `~/.claude/settings.json`.
- Tools needing permission: Bash, Write/Edit/NotebookEdit, WebFetch/WebSearch, MCP, Skill. No-prompt: Read/NotebookRead, Grep/Glob, TodoWrite, Task, plus a built-in read-only Bash set (`ls cat echo pwd head tail grep find wc which diff stat du cd` + read-only `git`).
- Sandbox (`/sandbox`): OS-level Bash isolation — bubblewrap (Linux) / Seatbelt (macOS); fs + network boundaries; complements (doesn't replace) deny rules.

### 3.7 The background-agent daemon bridge (wrap, don't rebuild)

Parallel/background agents are owned by CC's daemon. The IDE's agents panel is a **view over it**:
- `claude agents` — native agent view (sessions, statuses).
- `claude daemon status` — supervisor reachable?, PID, version, socket dir, live count (`/doctor` includes the same). Version-skew → `claude daemon stop --any`.
- Background sessions: launched via `/bg` (or the background launch flag — **confirm exact spelling against the CLI**); each gets `CLAUDE_JOB_DIR` (`~/.claude/jobs/<id>`); deleting a session in agent view removes the worktree it created (`claude rm` keeps a worktree with uncommitted changes).
- Worktrees: parallel local sessions use git worktrees; a `.worktreeinclude` file copies gitignored files (e.g. `.env`) into new worktrees.
- **Git-repo prerequisite (gate it).** Worktrees require an initialized git repository. A workspace can be a **plain non-git directory** (§5.A.4), where worktree mechanics fail with fatal git errors. So the parallel-agents feature must **detect `is-git-repo` and disable itself gracefully** in non-git workspaces — the agents dashboard shows "parallel agents require a git repository" (offer `git init`), **not** a raw shell error. The rest of the IDE (single session, structured/interactive modes, editing, search) is **unaffected** in a plain directory — it needs no worktree.
- Process mgmt: `/tasks`, `/bashes`, `/kill <id>`.
- Availability: agent view can be disabled (`disableAgentView` / `CLAUDE_CODE_DISABLE_AGENT_VIEW`); detect and degrade gracefully.
- **The IDE never spawns its own background fleet** — it dispatches via these and reads status.

### 3.8 Cost & usage sources (P4)

- Slash: `/cost` (API users — $ spend), `/stats` (Pro/Max — usage; 7/30/all-time), `/usage` (rate-limit window).
- Programmatic: `--output-format json` and the stream-json `result` event both carry `total_cost_usd` + `usage`.
- Status line: `claude config set status_line.show_cost true`; snapshots in `~/.claude/statusline.jsonl`. Community tool `ccusage` reads the JSONL for historical trends.
- `DISABLE_COST_WARNINGS=1` suppresses warnings.

### 3.9 Project deletion (the guardrail, formalized)

`claude project purge [path]` (**v2.1.124+**) is the ONLY sanctioned deletion. It removes transcripts, tasks, file history, project config, and the project's `~/.claude.json` entry. Flags: `--dry-run` (plan only), `-y` (skip confirm), `-i` (step through), `--all` (every project; also drops `history.jsonl`). It prints the deletion plan and confirms; leaves `shell-snapshots/` and `backups/` alone; exits 1 if no state matches.
- IDE flow: **always `--dry-run` first → show plan → confirm → execute.**
- **NEVER** `fs::remove_dir_all` / `rm -rf` on `~/.claude/...`. **Never** delete `~/.claude.json`, `~/.claude/settings.json`, or `~/.claude/plugins/`.

### 3.10 Preflight & environment

**Preflight before any spawn:** (1) path exists & is a dir; (2) `claude` on PATH (`which claude`); (3) version (`claude --version`); (4) authenticated — `claude auth status` (exit 0 logged-in / non-zero not — **verify exact command against the installed CLI**; `/doctor` corroborates). On failure → guided UI error; do not spawn.

**Env the IDE may set/read (do NOT misuse):**
- `CLAUDE_CONFIG_DIR` — relocates the **entire** config home; **do not use for per-workspace isolation** (fragments auth/settings/MCP). Isolate by `cwd`.
- `CLAUDE_PROJECT_DIR` — overrides project dir (skills/hooks context).
- `ANTHROPIC_API_KEY` — auth (prefer the CLI's own login; the IDE stores no keys).
- Limits: `MAX_THINKING_TOKENS` (default 31,999), `CLAUDE_CODE_MAX_OUTPUT_TOKENS` (default 32,000, max 64,000), `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS`.
- Quiet/offline: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`.

**Settings the IDE may surface/respect:** `language`, `attribution`, `cleanupPeriodDays`, `plansDirectory`, **`prefersReducedMotion`** (feeds the a11y motion setting in Part 4), `permissions`, status-line config. Parse `.claude/rules/`, `.claude/skills/`, `.claude/commands/`, `.claude/agents/` to populate the command palette and rules view.

### 3.11 Wrap-vs-build summary

| Capability | Native CLI mechanism | IDE role |
|---|---|---|
| Agent loop / turns | `claude -p … stream-json` | **wrap** (render events) |
| Interactive session | `claude` TUI in PTY | **wrap** (host in xterm) |
| Sessions list / resume | index file + `--resume` | **wrap** (sidebar) |
| Branch / rename / clear | `/branch` `/rename` `/clear` | **surface** (buttons → PTY) |
| Checkpoint / rollback | `/rewind` | **surface** (timeline UI) |
| Approvals | `--permission-prompt-tool` MCP | **build the UI**, wrap the mechanism |
| Permissions config | settings.json + `/permissions` | **build the UI**, wrap the files |
| Parallel agents | `claude agents` + daemon + worktrees | **wrap** (dashboard) |
| Cost / usage | `/cost` `/stats` `/usage` + json `usage` | **build the dashboard**, wrap the data |
| Deletion | `claude project purge` | **wrap** (never hand-roll) |
| Editing / LSP / git / search | — (not CC's job) | **build** (Monaco etc., Part 5) |

---

---

## Part 4 — Frontend Architecture & Design System

> This part decides whether the IDE *looks* like a serious instrument or looks vibe-coded. The rule throughout: **the agent loop is the hero, every working surface stays quiet and disciplined, and boldness is spent in exactly one place** (the signature, §4.2). Every color, size, and motion value references a **token** (§4.3) — no hardcoded values anywhere in the codebase.

### 4.1 Frontend architecture

- **Stack:** TypeScript + Vite + **React** (rationale: mature Monaco (`@monaco-editor/react`) and xterm.js bindings, large ecosystem). *Lean alternative if bundle size becomes critical: Svelte — note the tradeoff and decide in plan mode.*
- **State:** the **derived, read-only store** (Zustand or equivalent) that mirrors backend truth (Part 2 §2.5). It never owns state; it rebuilds from `workspace_state_changed` events + channel streams. Each workspace tab is its own component subtree; Monaco/xterm instances are per-tab and **disposed on close** (no webview leaks).
- **Styling:** design tokens are **CSS custom properties** — the single source of truth. A thin utility layer (Tailwind v4's CSS-first config, or vanilla CSS modules) consumes the tokens. **No literal hex, px, or duration in any component** — always `var(--token)`. This rule is what keeps the system coherent and is checked in review.
- **Component model:** composable panels, a **layout/docking manager**, a **command registry** (§4.5), and a **theming layer** (§4.8) are the four structural primitives everything else is built from.

### 4.2 Design identity — the thesis

**The product is a control surface for an autonomous agent.** The visual language borrows from precision instruments and mission-control panels: a calm, cool-dark base; high legibility tuned for long sessions; disciplined status semantics; and **monospace as a first-class voice**, not just inside code. The streaming agent conversation is the centerpiece, rendered with editorial restraint — generous spacing, clear turn boundaries, tool calls as distinct objects.

**Deliberately not the default.** The common AI-dark look is *pure black + one bright acid accent*. We reject that: the base is a **cool blue-graphite (not black)**, the accent is a **warm amber** (a status-lamp signal, used sparingly), and status is carried by a **semantic palette** rather than one color doing all the work. This is a choice made for this brief, not a template.

**The signature — the Timeline Rail.** Sessions and checkpoints render as a **vertical branching rail** (a git-graph motif) down the session sidebar: `/branch` shows a visible fork, `/rewind` checkpoints are scrubbable nodes, the active turn pulses softly at the head. It encodes real structure (the agent's branching, time-travelable history) and is the one element the product is remembered by. Everything around it stays quiet.

### 4.3 The token system (concrete starting values — tune to taste, but keep the structure)

**Brand palette (named):**
| Token | Hex | Role |
|---|---|---|
| Graphite | `#15171C` | base background (cool, not black) |
| Slate | `#1D2026` | raised surface (panels, cards) |
| Onyx | `#0F1115` | recessed (editor gutter, wells) |
| Ash | `#9AA1AD` | muted / secondary foreground |
| Bone | `#E6E8EC` | primary foreground (off-white, not #FFF) |
| Amber | `#E9A04A` | primary accent / agent-active / primary action |

**Functional tokens (derive, don't scatter):**
- Background layers: `--bg-base` (Graphite), `--bg-raised` (Slate), `--bg-recessed` (Onyx), `--bg-overlay` (Slate @ elevation).
- Foreground: `--fg-primary` (Bone), `--fg-secondary` (Ash), `--fg-muted` (`#6B7280`), `--fg-disabled`.
- Borders: `--border-subtle` (`#262A31`), `--border-strong` (`#343A44`), `--focus-ring` (Amber @ 60%).
- Accent: `--accent` (Amber), `--accent-hover`, `--accent-quiet` (Amber @ low alpha for backgrounds).
- **Semantic status** (mapped to the Part 2 state machine): `--status-idle` (Ash), `--status-running` (Amber), `--status-awaiting` (`#E3B341` warning-amber), `--status-success` (`#5FB389`), `--status-danger` (`#E5736B` desaturated coral), `--status-info` (`#6CA0D0`).
- **Diff**: `--diff-add` / `--diff-add-bg`, `--diff-del` / `--diff-del-bg`, tuned for the dark base (sufficient contrast, never neon).
- Every token pair **must meet WCAG-AA** against its background — verify each; muted and accent-colored text are the ones to watch.

**Typography:** UI/body face **Geist Sans**, code/data face **Geist Mono** (both designed for developer interfaces; a deliberate pairing, not the Inter default; system fallbacks defined). **Type signature:** Geist Mono is the *identity voice* — session IDs, token counts, costs, status labels, and the command-palette prefix are all mono, tying the UI to the terminal-native subject.
- Scale (tokens): `--text-xs 11` / `--text-sm 12` / `--text-base 13` (IDE-dense default) / `--text-md 14` / `--text-lg 16` / `--text-xl 18` / `--text-2xl 22` / `--text-3xl 28`, each with a paired line-height token. Weights: 400 body, 500 UI labels, 600 headings.

**Spacing** (4px base): `--space-1 2` / `2 4` / `3 8` / `4 12` / `5 16` / `6 24` / `7 32` / `8 48`. **Radius:** `--radius-sm 4` / `md 6` / `lg 8` (IDE feel — never pill). **Elevation:** dark UIs lean on borders + subtle shadow — `--elev-1` (border only), `--elev-2` (border + soft shadow), `--elev-3` (overlay/modal).

**Motion** (restrained — extra animation reads as AI-generated): `--motion-fast 120ms`, `--motion-base 180ms`, `--motion-slow 280ms`; easing `--ease-standard` (cubic-bezier ~`.2,0,0,1`). Motion is functional only: streaming token reveal (subtle), the status-lamp pulse on the active turn, panel resize/collapse. **All motion is gated behind `prefers-reduced-motion` and the CC `prefersReducedMotion` setting (Part 3 §3.10)** — when reduced, transitions become instant.

### 4.4 Layout & docking model

```
┌──────────────────────────────────────── workspace tabs ──────────────────────────────┐
├───────────────┬───────────────────────────────────────────────┬───────────────────────┤
│  SESSIONS      │             AGENT CONVERSATION (hero)          │   EDITOR / DIFF        │
│  + Timeline    │   streaming cards · tool calls · approvals     │   Monaco · side-by-    │
│  Rail (sig.)   │   ───────────────────────────────────────────  │   side git diff ·      │
│  (~280px)      │   prompt bar (slash + @ autocomplete)          │   md preview (~45%)    │
├───────────────┴───────────────────────────────────────────────┴───────────────────────┤
│  TERMINAL DRAWER — xterm.js hosting the interactive `claude` TUI (collapsible)          │
└────────────────────────────────────────────────────────────────────────────────────────┘
```
- **The hero is the center conversation pane** — widest by default, highest visual priority. Editor and sessions flank it; the terminal is a drawer.
- **Dockable panels:** each region is resizable (drag handles), collapsible, and its layout **persists** per workspace. Panels can be hidden entirely (keyboard-toggled). Define sensible **min/max** widths; below a threshold the layout gracefully reduces (e.g. editor collapses to an icon rail).
- **Multi-window:** support Tauri multi-window (tear a workspace into its own window). Each window owns its tabs.
- **Tabs:** workspaces are tabs; switching rebinds all four regions instantly (Part 2). The active workspace's status (idle/running/awaiting/error) shows in its tab via the semantic status color.

### 4.5 Command palette & keyboard model

- **Command palette is the spine** (`Ctrl/Cmd-K`): every action — open folder, new turn, resume/branch/rewind, toggle panels, run a slash command, switch model, open settings — is reachable here, fuzzy-searchable, with the mono prefix as identity. Backed by a **command registry** (each command: id, title, keybinding, when-context, run()).
- **Keyboard-first, two zones:** when focus is in the **prompt bar or terminal**, the native CC bindings pass through (Part 3): `Tab` autocomplete, `Shift+Tab` plan-mode cycle, `Esc`/`Esc+Esc` abort/rewind, `↑/↓` history, `Ctrl+C` abort, `!` bash prefix, `@` file completion. When focus is in **IDE chrome**, IDE bindings apply (palette, panel toggles, tab switching, focus movement). The keymap is **discoverable** (shown in the palette and tooltips) and **rebindable**.
- **Focus management:** explicit focus zones, **`:focus-visible` on everything**, logical tab order, no focus traps, and a visible focus ring (the `--focus-ring` token).

### 4.6 Core states, streaming UX, onboarding & copy

**Every view defines three states** (this is the anti-vibe-coded mandate — no blank screens, no raw errors, no infinite spinners):
- **Empty** is an invitation to act. No workspace open → a real welcome/onboarding panel (not a blank pane). No sessions yet → "Start your first session" with the action inline.
- **Loading** uses skeletons or live streaming, **never an unbounded spinner** — every async op has a timeout and a recovery affordance.
- **Error** gives direction, in the interface's voice: what happened + how to fix it + a "Details / Copy logs" affordance. **Never** a raw stack trace; **never** a vague apology.

**Streaming UX:** tokens reveal with a subtle fade; tool calls appear as distinct, collapsible cards (name + input summary, expandable to full); a **permission/approval card** (P1) interrupts inline with the proposed action as a **diff** plus Approve / Edit / Reject (the `updatedInput` path lets the user edit before running); cost/context updates live in the header without reflowing the conversation.

**Onboarding (first run):** preflight (`claude` installed + authed → guided fix if not, Part 3) → open a folder → a gently guided first turn. No account walls the IDE owns; it rides the CLI's auth.

**Copy voice** (copy is design material): name things by what the user controls, not how the system is built ("Approve change," not "Resolve permission event"); active voice; an action keeps its name through the flow (the button says "Branch," the result says "Branched"); sentence case; no filler.

### 4.7 Accessibility baseline (a quality floor, not a feature)

- **Full keyboard operability** — every action reachable without a mouse (the palette guarantees this).
- **`prefers-reduced-motion`** honored app-wide (and the CC `prefersReducedMotion` setting): pulses/fades become instant.
- **WCAG-AA contrast** across all token pairs — verified.
- **`:focus-visible`** everywhere; ARIA roles/labels on custom widgets; the streaming conversation uses an ARIA **live region** so screen readers announce new content; the terminal exposes its accessibility tree.
- **Respect OS light/dark** preference as the default theme; honor app theme override.
- **Scales to 200% zoom** without breakage (tokens + relative units make this fall out naturally).

### 4.8 Theming

Theming is **token substitution**: ship **Dark (default)** and **Light** by overriding the token set; custom themes are just another token map (load/validate a theme file). Keep all components theme-agnostic by referencing only tokens. (The IDE's theming is its own; it need not sync with the CLI's `/theme`, but may read OS preference for the initial choice.)

---

---

## Part 5 — Feature Specifications

> Every feature below uses the same template: **Purpose · UI · Mechanism · States · Acceptance · Edge cases.** "Done" means the **Acceptance** items are demonstrably met (Part 1 §1.4) — not "it renders." Mechanisms reference Part 3; states reference the three-state mandate (Part 4 §4.6).

### 5.A — Core surfaces

#### 5.A.1 Agent Conversation (the hero)
- **Purpose:** run and read the agent loop as clean cards, never raw ANSI.
- **UI:** center pane — streaming assistant text, collapsible tool-use cards (name + input summary), tool-result cards, turn boundaries, the active turn pulsing in the status color; a prompt bar at the bottom with slash- and `@`-autocomplete.
- **Mechanism:** the persistent engine's `EngineEvent` stream (§2.3); the prompt bar calls `engine_send` (into the live session); autocomplete sources the available `slash_commands` (from the `Init` event) + `.claude/skills`/`commands` + the file tree (for `@`).
- **States:** empty ("Ask Claude to…"), streaming (live reveal), awaiting-approval (P1 card inline), error (turn failed → retry), stopped (cancelled, clean).
- **Acceptance:** tokens render ≤50 ms p95 from event; tool cards expand/collapse; cancel mid-stream yields a clean `Stopped`; `session_id` captured and reused next turn; markdown + syntax-highlighted code render; copy-message works; **zero ANSI artifacts** (structured events, not TUI scraping).
- **Edges:** malformed event → `ParseError` surfaced, not crashed; very long output → virtualized scroll; rapid deltas coalesced without dropping tool/result/permission events; engine death mid-turn → failed + retry.

#### 5.A.2 File Explorer
- **Purpose:** navigate and open the workspace.
- **UI:** tree, fuzzy file-open (via palette), context actions (new/rename/delete/reveal), optional `.gitignore` dimming.
- **Mechanism:** Tauri fs scoped to the workspace root (Part 2 §2.8); debounced `notify` watcher for external changes.
- **States:** empty folder, loading (large tree → progressive), error (denied → message).
- **Acceptance:** opens files in Monaco; reflects external changes within the debounce window; **never** touches paths outside the workspace root.
- **Edges:** huge directories (virtualize); symlinks (canonicalize, no loops); externally deleted open files (mark stale).

#### 5.A.3 Monaco Editor
- **Purpose:** real code editing.
- **UI:** right pane, multi-tab, dirty indicators, save (`Ctrl-S`), side-by-side + unified diff, markdown preview.
- **Mechanism:** Monaco. *LSP autocomplete / go-to-definition / diagnostics (via local language servers) is a planned **post-v1** enhancement, not part of v1 — mark as planned.*
- **States:** empty (welcome/recent), unsaved, error (write failed).
- **Acceptance:** open/edit/save round-trips; dirty state accurate; diff renders both modes; **disposed on tab close (no leak)**; size guard prevents freezes on huge files.
- **Edges:** external-edit conflict (reload/keep); binary files (don't open as text); unsaved-on-close (prompt).

#### 5.A.4 Git Panel
- **Purpose:** see and act on git state without leaving.
- **UI:** status list (staged/unstaged/untracked), stage/unstage, commit box, branch switch/create, diff click-through into Monaco, optional blame.
- **Mechanism:** validated, scoped git via the backend; destructive ops gated behind confirmation. Aware of the worktree reality (Part 3 §3.7).
- **States:** not-a-repo (offer init), clean, error (readable git message).
- **Acceptance:** stage/unstage/commit work; diffs match `git diff`; branch ops work; **never runs `push`/`reset --hard`/etc. without explicit confirm.**
- **Edges:** detached HEAD; merge conflicts (surface, don't auto-resolve); large diffs (stream).

#### 5.A.5 Global Search
- **Purpose:** find across the workspace.
- **UI:** query, results grouped by file, click-to-open at line, optional replace-with-preview.
- **Mechanism:** ripgrep via backend, scoped to the workspace root, results streamed.
- **States:** empty (no query), no-results, error.
- **Acceptance:** results stream; click opens at the right line; respects `.gitignore`; scoped to the workspace.
- **Edges:** huge result sets (cap + "show more"); regex errors (inline message).

#### 5.A.6 Terminal Drawer
- **Purpose:** host plain shells; optionally, an explicitly-unmanaged raw `claude` passthrough.
- **UI:** collapsible bottom drawer, xterm.js, multiple terminal tabs — **plain shells by default.** The native `claude` TUI may be offered as an **unmanaged passthrough** (§2.2 boundary rule: no mirroring, no injection, native prompts); v1 may defer it.
- **Mechanism:** portable-pty (§2.3); resize on drawer resize.
- **States:** collapsed, active, process-exited (offer restart).
- **Acceptance:** full shell interactivity (keys, color, resize) with ≤16 ms echo; **closing kills the PTY (no zombie)**; restart works; if the `claude` passthrough is shown, the IDE does **not** inject into it or claim its output in the structured pane.
- **Edges:** PTY death (offer restart); huge output (scrollback cap); resize races.

### 5.B — Power features (the differentiators)

#### P1 — Change-Review Queue
- **Purpose:** nothing hits disk without the developer seeing it as a diff and approving — or editing — it first.
- **UI:** an approval card inline in the conversation (plus a queue panel when several are pending): the proposed action shown as a **diff** (Write/Edit) or a **command preview** (Bash); buttons **Approve / Edit / Reject**. Edit opens the input for modification before it runs.
- **Mechanism:** the permission handler is wired **once at engine-session start** (§2.3), not per turn. Preferred: the Agent SDK's **`canUseTool` callback** — an in-process hook in the engine sidecar, no extra server. Alternative: a **local MCP server** exposing `mcp__ide__permission_prompt`, registered once at session start via `--mcp-config '<inline def>'` (+ `--strict-mcp-config`) with `--permission-prompt-tool mcp__ide__permission_prompt`. **Neither touches `~/.claude.json`.** On a tool call not settled by a static rule, the handler receives `{tool_use_id, tool_name, input}`, the IDE surfaces the card, **blocks on the user**, and returns `{behavior:"allow", updatedInput}` or `{behavior:"deny", message}` (§3.6). `updatedInput` powers **Edit**. Because the handler lives for the whole session, approvals add **no per-turn connection latency**.
- **States:** idle (none pending), pending (awaiting user), approved/rejected (resolved), away (long-idle → **keep blocking but with a timeout that auto-denies** so the engine is never hung forever — **never auto-allow**).
- **Acceptance:** every tool call not covered by a static allow/deny rule surfaces a card *before* execution; Approve runs it; Reject denies with the user's reason; Edit runs the modified input; static-rule-covered calls do **not** prompt (respect the three-layer order); the handler is local-only and torn down with the engine. **The raw terminal passthrough is explicitly out of scope for this queue** — it uses the CLI's native prompts (§2.2 boundary rule), stated plainly in the UI.
- **Deadlock safety (the blocking-call risk):** when the handler is called, the turn **blocks** awaiting the decision. The IDE must therefore (1) keep the handler/connection alive (a **heartbeat** for the MCP variant; the in-process callback for the SDK variant); (2) apply a **configurable timeout** after which it returns `{behavior:"deny", message:"approval timed out"}` — a *clean* response that ends the wait without hanging and **without a process-kill**; (3) expose an explicit **"abort turn"** that resolves the pending request as a deny and uses the SDK **interrupt** (§2.3). The engine must never be left blocked indefinitely; the UI stuttering or being minimized must not hang the turn.
- **Edges:** the raw `--permission-prompt-tool` flag is undocumented → the **`canUseTool`** path is the primary, documented mechanism; simultaneous requests → an ordered queue; handler crash → **fail safe (deny)**, surface error, never silently allow; user dismisses the card → resolves as a deny per setting, never auto-allow.

#### P2 — Visual Checkpoint Timeline (the signature)
- **Purpose:** time-travel — roll conversation and/or files back to any checkpoint, visually.
- **UI:** the **Timeline Rail** (Part 4 §4.2) — checkpoints as nodes, branches as forks; hover previews the diff since that point; click offers **Rewind: code only / conversation only / both**.
- **Mechanism:** surface native `/rewind` (alias `/checkpoint`, `Esc+Esc`); the IDE visualizes and issues the rewind, the **CLI performs the rollback** — no hand-rolled file restoration, ever.
- **States:** empty (no checkpoints), populated, rewinding, post-rewind (reflect new head).
- **Acceptance:** checkpoints display in order with branch structure; the three modes work and map to the CLI; a rewind visibly updates the conversation and (when chosen) the files; **no hand-rolled file rollback anywhere.**
- **Edges:** checkpoint shape varies by version (probe, Part 3); failed rewind → clear error, state unchanged; long histories (virtualize the rail).

#### P3 — Permission / Allowlist Manager
- **Purpose:** control what Claude does without prompting — fewer interruptions, full transparency.
- **UI:** a panel listing allow/deny/ask rules (add/edit/remove), a `defaultMode` selector, `additionalDirectories`, a per-rule indicator of its config layer (managed/CLI/local/project/user), and a tester ("would `Bash(npm test)` prompt?").
- **Mechanism:** read/write the project `.claude/settings.json`, surface the user file; honor the rule format + precedence (Part 3 §3.6); optionally drive `/permissions`.
- **States:** empty (defaults explained), populated, conflict (a deny shadows an allow → warn), error (malformed settings → safe read).
- **Acceptance:** rules persist with correct syntax (incl. MCP `mcp__server__tool`, **no parentheses**); precedence shown accurately; the tester predicts prompt/allow/deny correctly; **never writes a rule that broadens access without the user's explicit action.**
- **Edges:** managed/enterprise settings are read-only (show, don't override); glob spacing pitfalls (warn `Bash(ls *)` ≠ `Bash(ls*)`); known deny-rule bugs → recommend pairing critical denies with a hook.

#### P4 — Live Cost & Context Dashboard
- **Purpose:** always know token usage, context headroom, and spend — per session and over time.
- **UI:** a compact header indicator (mono, identity voice) — context-fill bar + session cost; an expandable dashboard with per-session/per-day usage, a context-limit gauge, and trend history.
- **Mechanism:** live `usage`/`total_cost_usd` from the **engine's** `result` events; `/context` for the gauge; `/cost` (API) / `/stats` (Pro/Max) / `/usage` (rate window) for totals; optionally `~/.claude/statusline.jsonl` + the `ccusage` approach for history (Part 3 §3.8). **Cost from these sources — never guessed from raw JSONL.**
- **States:** empty (no turns), live (updating mid-turn), error (a source missing → degrade, show what's available).
- **Acceptance:** cost/usage update live during a turn without reflowing the conversation; the gauge reflects real headroom; subscription users (no `/cost`) see `/stats`/`/usage`, not a broken panel; numbers reconcile with the CLI's own commands.
- **Edges:** field names vary by version (probe); rate-limit vs dollar-cost are different axes (don't conflate); missing source degrades gracefully.

#### P5 — Cross-Session Search
- **Purpose:** find a past decision or fix fast, across all sessions.
- **UI:** a search surface (palette + dedicated panel) — query → cross-session results with snippet + session/timestamp; click opens (resumes) that session.
- **Mechanism & honest scope:** two depths. (1) **Prompt-level recall** across all projects from `~/.claude/history.jsonl` — but this is the **prompt index (the questions asked), not full responses, tool outputs, or diffs.** (2) **Full-text** search over the **retained** transcripts. The index is **not a per-keystroke re-parse and not a paradox:** an inverted index stores **terms → document positions** (a rebuildable derived structure) plus **short display snippets**, so a query hits the index instantly and snippets are fetched on demand from the still-present transcript. What is **forbidden** by §1.4.7 is a **complete durable mirror of transcript content that outlives the CLI's own deletion** — i.e. using the index as a shadow archive. Terms/positions + short snippets ≠ a content archive; that distinction is the whole point.
- **The retention reality (and the only sanctioned durability fix):** transcripts auto-delete after `cleanupPeriodDays` (default 30), so full-text search **cannot see expired sessions** (their index entries point at deleted files and are pruned) — and you must **not** hand-roll a transcript archive to work around it. The sanctioned fix is to let the user **raise `cleanupPeriodDays` (or disable cleanup) via the CLI's own setting** (§3.10): the CLI keeps the data, search reads it in place. Be upfront in the UI that recall depth degrades past the retention window on the default.
- **States:** empty (no query), no-results, indexing (large history → progressive), error.
- **Acceptance:** prompt-level matches found across all projects; full-text matches found for retained sessions; click opens/resumes the correct session **in the right cwd** (§3.2); **never loads whole transcripts into memory** and **never copies transcript content to a private store**; respects `~/.claude` read-only.
- **Edges:** very large history (incremental index + cap); expired sessions (gracefully absent + a hint that retention can be extended in settings).

### 5.C — Agents / Parallel Dashboard (v2 extension)
- **Purpose:** see and manage parallel/background agents.
- **UI:** a dashboard of active agents/sessions (status, branch/worktree, cost) with start/stop/open + daemon health.
- **Mechanism:** **wrap** `claude agents` + `claude daemon status` + worktrees (Part 3 §3.7); **never spawn our own background fleet.**
- **States:** **non-git workspace (feature disabled, "requires a git repo" + offer `git init`)**, daemon-down (degrade + hint), no-agents, populated, error.
- **Acceptance:** reflects the daemon's real list/status; open/stop map to the CLI; **disabled gracefully (no raw git error) when the workspace is not a git repo** (§3.7); degrades cleanly when the agent view is unavailable.
- **Edges:** daemon version skew (`claude daemon stop --any`); worktree cleanup semantics (deleting in agent view removes the worktree; `claude rm` keeps one with uncommitted changes).

---

---

## Part 6 — Phased Roadmap, Definition of Done & Acceptance Plan

> This turns the spec into a buildable sequence. The build is **gate-driven, not date-driven**: a phase ships only when its **acceptance gate** is green (Definition of Done, §6.2). Effort sizes are rough and pace-dependent — relative, not deadlines. Small wins first; every phase ends demoable and committed.

### 6.1 The roadmap

**v1 — the thin, correct, usable wrapper**

**Phase 0 — Skeleton & preflight** · *size: S*
- Builds: Tauri app boots; the three-column + drawer shell (§4.4) renders with dummy data; Monaco + xterm mount; the token system (§4.3) wired as CSS vars; the preflight module (§3.10).
- Gate: launches within the cold-start budget; layout renders; preflight correctly detects `claude` present/absent + authed/not and shows the guided error path; **RSS budget validated here** — this is where WebKitGTK reality is measured; adjust the budget with evidence if needed.
- Blocker: Tauri Linux deps installed (`apt`).

**Phase 1 — Persistent engine + conversation pane** · *size: L*
- Builds: open a folder → preflight → start the **persistent Agent-SDK streaming session** (sidecar), cwd-locked, handle in managed state, torn down cleanly on close → `engine_send` streams `EngineEvent`s → `Channel<EngineEvent>` → the conversation pane (cards, streaming reveal, tool cards); multi-turn into the live session; SDK interrupt for cancel.
- Gate: tokens render ≤50 ms p95; tool-use/result cards render; cancel yields a clean `Stopped`; `session_id` captured from `Init`; **zero ANSI artifacts**; a malformed event surfaces `ParseError` without crashing; **closing the workspace leaves no zombie process**; app-exit teardown clean.
- Depends on: Phase 0.

**Phase 2 — Plain terminal drawer** · *size: S*
- Builds: the xterm.js drawer hosting a **plain shell** via `portable-pty` (keys/color/resize, ≤16 ms echo), cwd-locked, killed cleanly on close. *(The optional native `claude` passthrough — explicitly unmanaged, §2.2 — is deferred; can be added later.)*
- Gate: full shell interactivity; **no zombie on close**.
- Depends on: Phase 0 (independent of Phase 1 — can parallelize).

**Phase 3 — Sessions & Timeline Rail (basic)** · *size: M*
- Builds: resolve sessions on open via the `~/.claude.json` registry (§3.2) → session list; watch `~/.claude/projects/` for new sessions; the Timeline Rail (§4.2) rendering session/branch structure; resume / rename / branch / clear / rewind buttons → the **structured engine** (§3.3).
- Gate: the list matches the CLI's sessions and populates **on open** (no forced turn); a brand-new session appears **live** (§3.2); resume opens the right session in the right cwd; rename/branch/clear/rewind each work via the structured engine; **no hand-rolled file rollback** (rewind is the CLI's).
- Depends on: Phase 1.

**Phase 4 — Editor surfaces** · *size: L*
- Builds: file explorer; Monaco multi-tab + save; side-by-side/unified git diff; git panel (status/stage/commit/branch); global search (ripgrep). All scoped to the workspace root.
- Gate: each surface's Part 5 acceptance criteria met; Monaco instances disposed on tab close (no leak); git never runs destructive ops without confirm; nothing touches paths outside the workspace root.
- Depends on: Phase 0.

**Phase 5 — Multi-workspace routing & hardening** · *size: M*
- Builds: workspaces as tabs; the `WorkspaceRegistry` routes each to its own **engine session + terminal** by cwd; instant rebind on switch; every empty/loading/error state filled; the full perf-budget pass; the a11y pass.
- Gate: switching rebinds all regions instantly with **no context bleed**; **all performance budgets measured & met**; **all three states present on every view**; **a11y baseline passes**; the "no placeholders" grep is clean.
- Depends on: Phases 1–4.

> **v1 ships here** — a thin, correct, genuinely usable native Claude Code IDE. Tag a release.

**v2 — the differentiators**

**Phase 6 — P1 Change-review queue** · *size: L*
- Builds: the permission handler wired into the engine session (`canUseTool`, or the local MCP server once); the approval card (diff / command preview, Approve / Edit / Reject, `updatedInput` editing); `approve_permission` resolves the pending request.
- Gate: every non-statically-decided tool call surfaces a card before execution; Approve/Reject/Edit all behave; static-rule calls don't prompt; **MCP server crash fails safe (deny), never silently allows**; server is local-only + torn down with the app. If the raw flag is brittle → the Agent SDK `canUseTool` fallback is wired.
- Depends on: Phase 2.

**Phase 7 — P2 Checkpoint timeline (full) + P3 Permission manager** · *size: L*
- Builds: the Timeline Rail's full rewind UX (code-only / conversation-only / both, hover diff preview); the permission manager (allow/deny/ask editor, defaultMode, additionalDirectories, layer indicator, the "would this prompt?" tester).
- Gate: the three rewind modes map to the CLI and visibly update conversation/files; rules persist with correct syntax (incl. MCP no-parens form) to the right settings file; the tester predicts outcomes correctly; managed settings are read-only.
- Depends on: Phases 3, 6.

**Phase 8 — P4 Cost dashboard + P5 Cross-session search** · *size: M*
- Builds: the live cost/context header + dashboard (from `result` usage, `/context`, `/cost`//`stats`//`usage`); cross-session search over `history.jsonl` + indexes.
- Gate: cost/usage update live without reflowing; subscription users see `/stats`//`usage` (no broken panel); numbers reconcile with the CLI; search finds across projects and opens/resumes the right session in the right cwd; **never loads whole transcripts into memory**.
- Depends on: Phases 2–3.

**Phase 9 — Agents / parallel dashboard (v2 extension)** · *size: M*
- Builds: the daemon-bridge dashboard (wraps `claude agents` + `claude daemon status` + worktrees).
- Gate: reflects the daemon's real agent list/status; open/stop map to the CLI; degrades cleanly when the agent view is unavailable; **the IDE spawns no background fleet of its own**.
- Depends on: Phase 5.

**Phase 10 — Cross-platform, theming, release** · *size: M*
- Builds: macOS/Windows build + smoke pass; Light theme + custom-theme loading; final a11y + security audit; packaging.
- Gate: Linux reference fully green; macOS/Windows build and smoke-pass; the release checklist (§6.5) fully green.
- Depends on: all prior.

### 6.2 Definition of Done (every task, phase, and the whole project)

A unit of work is **done** only when ALL hold (this operationalizes Part 1 §1.4):
1. Code complete with **no placeholder/stub/TODO** on a reachable path.
2. **Error, empty, and loading states** present for any UI it touches.
3. The relevant **acceptance criteria** (Part 5 / the phase gate) demonstrably met.
4. **Tests** (unit and/or integration) or a clearly demonstrable manual verification.
5. **Input validation + Tauri capability scope** for any new external surface.
6. **Accessibility** (keyboard, focus-visible, reduced-motion, contrast) for any new UI.
7. **Performance** within budget for any hot path.
8. **Committed to git** with a clear message; the working state is reproducible.

### 6.3 Test & QA strategy

- **Fake before real.** Build a **mock engine** that replays canned `stream-json` for deterministic UI tests; wire the real CLI after the UI is proven.
- **Golden/snapshot tests for parsing.** Record real `claude -p … stream-json` output into fixtures; replay to lock the `EngineEvent` parser against regressions and surface schema drift loudly.
- **Unit (Rust):** slug logic, the workspace state-machine transitions, IPC error mapping, the line-reader/parser, path-sanitization. **Unit (TS):** store reducers, event/channel handling, the command registry, autocomplete sourcing.
- **Integration:** spawn a real headless turn in a temp dir and assert the event sequence; PTY write→echo round-trip; session-index read against a real `~/.claude/projects` fixture; `claude project purge --dry-run` returns a plan **without deleting**.
- **E2E / manual:** a written test script walking each feature's acceptance criteria.
- **Performance:** instrument every budget; a budget regression is a failing test.
- **Security:** path-traversal tests (a workspace command must reject `../` escapes); confirm no command exposes blanket shell-exec; a **zombie test** — open/close many workspaces, kill the app, assert no orphan `claude`.

### 6.4 Non-functional acceptance (all must pass before any release)

- **Performance:** every §2.7 budget measured and met on the reference machine.
- **Security:** least-privilege capabilities; path sanitization; **deletion only via `claude project purge`**; no zombies.
- **Accessibility:** keyboard-complete; reduced-motion honored; WCAG-AA; focus-visible; live regions for the stream.
- **Resilience:** crash-safe; graceful degradation when the daemon is down or a cost source is missing; engine/PTY death recoverable.
- **Cross-platform:** Linux reference green; macOS/Windows building + smoke-passing.

### 6.5 Release checklist (the final gate)

- [ ] All phase gates + non-functional gates green.
- [ ] `grep` confirms no `TODO`/stub on shipped paths; no dummy data in shipped UI.
- [ ] Preflight handles missing/unauthed `claude` gracefully.
- [ ] Deletion guardrail verified — no `fs::remove_dir_all` / `rm -rf` on `~/.claude/...` anywhere in the codebase.
- [ ] Pinned/known-good CLI version recorded; all "verify against the installed CLI" caveats checked against it.
- [ ] Zombie/crash test passed.
- [ ] Packaging for Linux (Pop!_OS → `.deb`; AppImage / `.rpm` as desired).
- [ ] `README.md` + `CLAUDE.md` present in the repo; pushed to GitHub.

### 6.6 Risk register (honest)

| Risk | Mitigation |
|---|---|
| `--permission-prompt-tool` is undocumented / may break | Agent SDK `canUseTool` fallback (§3.6); golden tests around the flow |
| `stream-json` / index schema drifts between CLI versions | parse by `type`, tolerate unknowns, tee raw, **probe** layouts; snapshot tests flag drift |
| WebKitGTK performance / quirks on Linux | measured in **Phase 0**; the RSS budget is a target to validate, not a guess |
| CLI breaking changes | pin a known-good version; the "validate against the installed CLI" rule throughout |
| Scope creep toward a full VS Code clone | the single design principle (§1.3) + phase gates; LSP/extensions are explicitly out of v1 |
| Concurrent same-session access → lock / corruption | **single persistent engine** — no second `claude` process on a session (§2.2); the optional raw passthrough is unmanaged and never co-live |
| Windows cancellation leaves dirty state | platform-specific interrupt (§2.3); prefer graceful turn-end / permission-deny over hard kill |
| MCP approval blocks the CLI indefinitely | heartbeat + timeout→clean-deny + explicit abort-turn (P1); never a process-kill |
| Search blind to expired transcripts | honest scope (prompt-level vs full-text); extend retention via the CLI's `cleanupPeriodDays`, never a private cache (P5) |
| Double-rendering the in-flight turn (stdout + file tail) | id-keyed reconciliation — stdout owns the live turn, transcript finalizes by id, watcher appends for the current turn ignored (§2.2) |
| Blind-scripting a busy interactive TUI | IDE actions go through structured input / flags, not `pty_write`; inject only when the TUI is provably idle (§2.3, §3.3) |
| Worktrees fail in plain non-git directories | detect `is-git-repo`; disable parallel agents gracefully there; core IDE unaffected (§3.7, §5.C) |
| Sidebar blank / mis-mapped on boot | resolve path→sessions from the CLI's `~/.claude.json` registry (read-only) on open, not from a forced turn or a reversed slug (§3.2) |

### 6.7 Out of scope (deliberately, for now)

Not in this spec: a VS Code-style extension marketplace; LSP (post-v1, Phase 10+); the original add-ons (LSP autocomplete, an `Understand-Anything` code-graph pane, drag-drop media into prompts) — these can come post-v1, and **`Understand-Anything` must be validated for existence / maintenance / license first**; cloud/remote sessions (`--remote` / `--teleport`) as a later addition.

---

## Specification complete (Parts 1–6)

This document is the full build brief. **Next step:** paste it into Claude Code and let it start **Phase 0 in plan mode** — it will propose the directory map and wait for your go-ahead before scaffolding a single file. Build gate by gate; tag a release at the end of v1.
