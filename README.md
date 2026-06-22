# Claude IDE

A native, agent-first desktop IDE that **wraps the Claude Code CLI** and makes the
agent loop the center of gravity — while remaining a real code editor. It is a
control surface for running, steering, reviewing, and *trusting* Claude Code's
work, with editing, git, and search around it so you never have to leave.

Built strictly to `Claude_Code_IDE_BUILD_SPEC.md` (the authoritative build brief),
phase by phase.

## Stack

- **Tauri 2** — Rust backend (orchestration) + web frontend.
- **React 19 + Vite 7 + TypeScript** — UI plane.
- **Tailwind v4** (CSS-first) consuming **design tokens** defined as CSS custom
  properties (the single source of truth).
- **Monaco** (editor/diff) and **xterm.js** (terminal), loaded locally (no CDN).
- Drives the installed **`claude`** binary — it owns sessions, permissions,
  checkpoints, and the background-agent daemon. The IDE launches, routes,
  renders, and surfaces; it never reimplements them.

## Prerequisites (Linux — Fedora/Nobara reference)

- **Rust** toolchain (`rustup`).
- **Tauri system deps** (Fedora/Nobara names):
  `sudo dnf install -y webkit2gtk4.1-devel gtk3-devel libsoup3-devel librsvg2-devel`
- **Node 18+** and **npm**.
- **Claude Code CLI** on PATH and authenticated (`claude auth status`).

## Develop

```bash
npm install            # frontend deps
npm run tauri dev      # build the Rust backend + launch the app
```

- `npm run dev` — frontend only (Vite).
- `npm run typecheck` — TypeScript check.
- `npm run tauri build` — production bundle.

## Status

**Phase 0 — Skeleton & preflight** (in progress). See `PROGRESS.md` for the
phased roadmap, current status, and blockers.
