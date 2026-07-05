<p align="center">
  <img src="src-tauri/icons/128x128.png" alt="Claude IDE icon" width="96" height="96" />
</p>

<h1 align="center">Claude IDE Linux</h1>

<p align="center">
  A native Linux, agent-first desktop IDE that <strong>wraps the Claude Code CLI</strong> —
  drive the agent loop, edit real code, and stay in one calm, fast, trustworthy app.
</p>

---

Claude IDE Linux makes the agent loop the center of gravity while remaining a real
code editor. It is a control surface for running, steering, reviewing, and
*trusting* Claude Code's work — with editing, git, terminal, and search around
it so you never have to leave. It replaces the "VS Code + a terminal + the
desktop app" sandwich with one purpose-built window.

**The wrapper contract (the app's spine):** the installed `claude` binary owns
the agent loop, sessions, turns, interrupts, permissions, checkpoints, and the
background-agent daemon. The IDE launches, routes, renders, and surfaces — it
never reimplements them, and it never touches your `~/.claude` data behind the
CLI's back.

## Features

**Agent loop, front and center**
- Persistent streaming `claude` session per workspace (`stream-json`), with
  live turns, tool-call cards, and interrupt.
- **Steer mid-turn**: queue follow-ups or interrupt-and-send while a turn is
  still streaming.
- **Attachments**: images (PNG/JPEG/GIF/WebP), PDFs, and text files via file
  picker or clipboard paste — sent as real content blocks, with size caps and
  honest refusals for what Claude can't consume (video/audio).
- Permission requests surfaced inline; approvals routed back to the CLI.
- Context-window / auto-compact warning banner, rate-limit instrumentation,
  and a usage dashboard.
- Error results are never swallowed — e.g. a model your plan doesn't include
  produces a plain-language notice, not silence.
- **Model picker + reasoning-effort picker** per session.

**A real editor around it**
- Sessions Timeline Rail: every past session, live-watched, resumable,
  searchable across transcripts.
- Monaco editor + diff viewer (loaded locally, no CDN), file explorer
  (create / duplicate / reveal), project-wide search.
- Git built in: status, staged/unstaged diffs, stage/unstage, commit,
  branches. Checkpoint timeline + diffs via the CLI's own checkpoints.
- Real PTY terminal drawer (`$SHELL` via portable-pty → xterm.js).

**Workshop tools**
- Command Palette + dev command set, status bar, editor toolbar.
- Settings surface: CLI settings, permissions editor, keybindings, MCP
  servers, and a managed **Plugins & Skills** view — browse the marketplace
  catalog and install from inside the app.
- Project-scoped **agent-definition builder** with quick-launch.
- **Global API token store** for GitHub / Hugging Face: saved once
  (`0600`-permission file, masked in the UI, never sent over IPC in full),
  injected as env vars into every agent session and terminal — without
  overriding variables you already set.

## Safety by design

- No shell-string execution: every spawned process is a fixed, resolved
  binary with argument vectors.
- Locked CSP, least-privilege Tauri capabilities.
- Deletion of Claude data only through the CLI's own `claude project purge` —
  the app never removes `~/.claude` content itself.
- Full teardown on exit: engine sessions, PTYs, and watchers reaped —
  zero zombies.

## Stack

| Layer | Tech |
|---|---|
| Shell | Tauri 2 (Rust backend, WebKitGTK webview) |
| UI | React 19 + Vite + TypeScript |
| Styling | Tailwind v4 (CSS-first) over design tokens (CSS custom properties) |
| Editor / Terminal | Monaco · xterm.js (both local, no CDN) |
| Agent | The installed `claude` CLI — sessions, permissions, checkpoints, daemon |

## Prerequisites (Linux — Fedora/Nobara reference)

- **Rust** toolchain (`rustup`), **Node 18+** and npm.
- Tauri system deps (Fedora/Nobara names):
  `sudo dnf install -y webkit2gtk4.1-devel gtk3-devel libsoup3-devel librsvg2-devel`
- **Claude Code CLI** on PATH and authenticated (`claude auth status`).

## Develop

```bash
npm install            # frontend deps
npm run tauri dev      # build the Rust backend + launch the app
```

- `npm run dev` — frontend only (Vite).
- `npm run typecheck` — TypeScript check.
- `npm run tauri build` — production bundle.
- `cargo test` (from `src-tauri/`) — backend test suite.

## Status

Feature-complete through the build spec's Phases 0–10 plus two addenda
(settings surface, command palette, agent bridge, plugin management, model /
effort pickers, steering, attachments, token store). Built gate-by-gate
against `Claude_Code_IDE_BUILD_SPEC.md`, with the running log in
`PROGRESS.md`.

**Honest pre-release note:** a full first-hand launch audit (2026-07-04)
passed every data-safety and security check, but flagged a punch list before
a v1 tag — performance budgets (cold-start / memory) not yet met on the
reference machine, conversation virtualization, focus management, and
frontend test coverage. Details in `PROGRESS.md`.

## License

[MIT](LICENSE) © 2026 Shaikh Saud
