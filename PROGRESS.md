# Claude IDE — Progress

Session save-file. Re-read at session start; update + commit after each
meaningful step. The authoritative brief is `Claude_Code_IDE_BUILD_SPEC.md`;
the build is **gate-driven**, phase by phase.

## Verified environment facts (probed 2026-06-22, against installed CLI)

- `claude` **2.1.185** at `~/.local/bin/claude`, authenticated. Newer than every
  version-gated feature in the spec.
- Auth check command: **`claude auth status`** (exit 0 = logged in) — verified.
- `claude project purge [path]` exists (the only sanctioned deletion path).
- stream-json / continuity flags all present (`--output-format`, `--input-format`,
  `--include-partial-messages`, `--resume`, `--fork-session`, `--from-pr`,
  `--session-id`, `--json-schema`, `--permission-mode`, `--mcp-config`,
  `--strict-mcp-config`, `--no-session-persistence`).
- `--permission-prompt-tool` is **NOT** in `--help` → P1 (Phase 6) uses the Agent
  SDK `canUseTool` path, as the spec anticipates.
- `claude doctor` = auto-updater health check (not daemon status); daemon-status
  spelling to re-verify at Phase 9.
- No per-project `sessions-index.json`; project dirs hold `<uuid>.jsonl` (+ a
  `memory/`). Boot session resolution will use `~/.claude.json` + jsonl
  enumeration (Phase 3 detail).
- OS: **Nobara 43 (Fedora-based)** — use `dnf`, not `apt`.

## Decisions

- Frontend: **React + Vite**. Styling: **Tailwind v4** consuming CSS-var tokens.
- Scaffolded from `create-tauri-app` (Tauri 2, react-ts), then customized.
- **Build the app with `npm run tauri build` (or `tauri dev`)** — a bare
  `cargo build` produces a binary that points at the Vite dev URL and shows
  "Connection refused" (it does not embed the frontend). Use the Tauri CLI.
- **Monaco is deferred** (lazy `EditorPane` behind an `EditorRegion` empty state)
  so it loads only when a buffer is opened — keeps the initial chunk at ~500 KB
  and idle RSS ~200 MB lower.
- NVIDIA hybrid GPU: launch with `WEBKIT_DISABLE_DMABUF_RENDERER=1` to avoid a
  blank webkit2gtk window.

## Phase 0 — measured performance (reference machine, production build)

The spec's 1.5 s / 250 MB figures were explicitly "targets to validate in
Phase 0 and adjust with evidence" (spec 2.7, 6.1, risk register). Measured:

| Metric | Original target | Measured | Notes |
|---|---|---|---|
| Cold start → shell ready | 1.5 s | **~2.85 s** | WebKitGTK webview/process-spawn floor on Linux; bundle size is not the bottleneck |
| Idle RSS — main process | 250 MB | **287 MB** | |
| Idle RSS — total (editor closed) | — | **650 MB** | WebKit web process ~298 MB even with no Monaco |
| Total with Monaco open | — | **~856 MB** | Monaco lives in the WebKit web process |

**Adjusted, evidence-based budgets (Linux/WebKitGTK reference):**
- Cold start ≤ **3.0 s** on Linux (revisit on macOS/Windows — faster webviews).
- Idle RSS: main process ≤ **320 MB**; total (editor closed) ≤ **~700 MB**;
  total with Monaco ≤ **~900 MB**.
- 250 MB total is unreachable on WebKitGTK (web content process alone ≈ 300 MB).

## Roadmap status

### Phase 0 — Skeleton & preflight  ·  COMPLETE ✅
- [x] Rust toolchain (cargo 1.96.0); Tauri deps via dnf.
- [x] Project scaffolded: Vite+React+TS frontend, Tauri 2 backend, path alias.
- [x] Design tokens (spec 4.3) as CSS custom properties (single source).
- [x] Three-column + drawer shell (spec 4.4) with dummy data + Timeline Rail.
- [x] Monaco mounts on demand (deferred), themed from tokens, disposed on unmount.
- [x] xterm mounted (themed, fit-to-container, disposed on unmount).
- [x] Preflight (spec 3.10) + guided-fix UI; verified live (authenticated=true).
- [x] Perf instrumented (cold-start marker + RSS); budgets measured & adjusted.
- [x] App builds + launches; shell renders; three states present.
- [x] Zero-warning Rust build; TS typecheck clean.
- [x] git init + first commit; pushed to GitHub (private):
      https://github.com/shaikh-saud705/claude-ide

### Phase 1 — Persistent engine + conversation pane  ·  IN PROGRESS
Architecture decided: **Rust drives `claude` directly via a persistent
stream-json session** (not a Node sidecar) — spec's sanctioned alternative.
Agent SDK stays the Phase 6 fallback for `canUseTool`.
- [x] EngineEvent contract (Rust enum + 1:1 TS mirror) over a tauri Channel.
- [x] Conversation store + pane: id-keyed items, streaming reveal, collapsible
      tool cards, cost/context header, working prompt bar (send + Stop).
- [x] Mock engine proves the pipeline end-to-end (spec 6.3 "fake before real").
- [x] Real NDJSON parser `engine::parse_events`, **8 golden tests** vs real CLI
      output. Committed: 4c7a99a.
- [ ] **NEXT — resume here: the real-engine swap.** Persistent `claude` child
      per workspace (cwd-locked, handle owned only in Rust); stdout →
      `parse_events` → per-workspace `Channel`; stdin writes each turn. Commands:
      `open_workspace` (default cwd = launch dir for now; folder picker is
      Phase 4), `engine_send(workspace_id, prompt)`, `engine_cancel` (interrupt),
      `close_workspace` (kill, no-zombie). Frontend: subscribe the channel once,
      `send` writes turns, capture `session_id` from Init. Couples backend +
      frontend (IPC signature change) → do together, finish with a live turn.
- [ ] Gate: tokens render ≤50ms; tool cards; cancel→clean Stopped; session_id
      captured; zero ANSI; ParseError surfaced; no zombie on close.

Resume facts (probed):
- Spawn: `claude -p --input-format stream-json --output-format stream-json
  --include-partial-messages --verbose --strict-mcp-config` in the workspace cwd.
- Send a turn (one NDJSON line to stdin):
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}`
- Events: `system`/init → Init; `stream_event` content_block_delta/text_delta →
  AssistantDelta; `assistant` tool_use → ToolUse; `user` tool_result →
  ToolResult; `result` → Result. (All locked by the golden tests.)
- Cargo needs tokio features `process` + `io-util` added for the async child I/O.

### Pending (later phases)
- Phase 2 — Plain terminal drawer (S)
- Phase 3 — Sessions & Timeline Rail, live (M)
- Phase 4 — Editor surfaces: explorer, Monaco multi-tab, git, search (L)
- Phase 5 — Multi-workspace routing & hardening (M) → **v1 ships**
- Phases 6–10 — P1 review queue, checkpoint timeline + permission manager,
  cost + cross-session search, agents dashboard, cross-platform/theming/release.

## Blockers
- None. Environment fully set up; production build green.

## Follow-ups (non-blocking)
- Bundle Geist Sans/Mono font files (currently system-font fallback).
- Tighten the CSP at the Phase 10 release audit.
- Consider lazy-loading xterm too, to shave a little more off the initial chunk.
- The env-gated cold-start marker (`CLAUDE_IDE_PERF_MARKER`) is dev/measurement
  instrumentation — keep using it to track budgets each phase.
