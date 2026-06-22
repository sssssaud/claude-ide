# Claude IDE

A native, agent-first desktop IDE that wraps the Claude Code CLI and makes the
agent loop the center of gravity, while remaining a real code editor. For
developers who want one app to drive Claude Code *and* edit real code.
Stack: Tauri 2 (Rust) · React 19 + Vite + TypeScript · Tailwind v4 · Monaco · xterm.js.

## Project goal
The best place to drive Claude Code while editing real code — calmer, faster, and
more trustworthy than stitching VS Code + a terminal + the desktop app together.
v1 = a thin, correct, genuinely usable wrapper (Phases 0–5). The build is
governed by `Claude_Code_IDE_BUILD_SPEC.md` (authoritative) and is gate-driven,
phase by phase. "Looks done" is not done — acceptance criteria are met, measured,
and committed.

## Operating contract (from spec 1.5 — follow every session)
- Plan mode first; propose, wait for explicit confirmation before scaffolding.
- Build strictly phase by phase (spec Part 6); stop and demo at each gate.
- One concern at a time, tested in isolation before integration; dummy data before
  real `claude` processes.
- Validate every CLI assumption against the installed binary (`claude --help`,
  `--version`, `auth status`, `/doctor`) — the installed CLI wins on any conflict.
- This is a **wrapper**: `claude` owns the agent loop, sessions, permissions,
  checkpoints, and the daemon. Never hand-roll those. Deletion ONLY via
  `claude project purge` — never `rm -rf` / `fs::remove_dir_all` on `~/.claude`.

## Directory map
- `Claude_Code_IDE_BUILD_SPEC.md` — the authoritative build brief.
- `PROGRESS.md` — session save-file: roadmap status, verified facts, blockers.
- `index.html`, `vite.config.ts`, `tsconfig*.json`, `package.json` — frontend build.
- `src/` — frontend (React + TS):
  - `styles/tokens.css` — design tokens (single source); `global.css` — base/a11y.
  - `ipc/` — typed `invoke` wrappers + TS mirror of backend types.
  - `store/` — derived, read-only Zustand store (mirrors backend truth).
  - `layout/` — WorkspaceShell, SessionsPanel (Timeline Rail), ConversationPane
    (hero), EditorPane (Monaco), TerminalDrawer (xterm).
  - `editor/` — Monaco local setup; `components/` — three-state + perf primitives.
- `src-tauri/` — backend (Rust / Tauri 2):
  - `src/` — `lib.rs` (builder + teardown), `commands.rs` (IPC), `preflight.rs`,
    `perf.rs`, `state.rs`, `error.rs` (thiserror → IpcError).
  - `tauri.conf.json` (window + locked CSP), `capabilities/` (least privilege).

## Stack / environment
- OS: Nobara 43 (Fedora-based) — **dnf, never apt**. Tauri deps:
  `webkit2gtk4.1-devel gtk3-devel libsoup3-devel librsvg2-devel`.
- Rust (rustup), Node 18+, Claude Code CLI 2.1.185 on PATH + authed.
- Reference machine: Dell G15 · i7-13HX · RTX 3050 6GB · 16GB RAM. Perf budgets
  (spec 2.7) are measured here, not assumed.

## Build / run commands
- Setup: `npm install`
- Run: `npm run tauri dev`
- Typecheck: `npm run typecheck`
- Build: `npm run tauri build`

## Current status
- Done: **Phase 0 complete** — shell, tokens, Monaco (deferred)/xterm mounts,
  preflight (verified live), perf measured. Production build green; budgets
  measured and adjusted with evidence (see PROGRESS.md). Toolchain + dnf deps in.
- Pending: Phase 1 — persistent Agent-SDK engine session + conversation pane.
- Blockers: none.
