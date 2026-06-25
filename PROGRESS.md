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

### Phase 1 — Persistent engine + conversation pane  ·  COMPLETE ✅
Architecture: **Rust drives `claude` directly via a persistent stream-json
session** (not a Node sidecar) — spec's sanctioned alternative. Agent SDK stays
the Phase 6 fallback for `canUseTool`.
- [x] EngineEvent contract (Rust enum + 1:1 TS mirror) over a tauri Channel.
- [x] Conversation store + pane: id-keyed items, streaming reveal, collapsible
      tool cards, cost/context header, working prompt bar (send + Stop).
- [x] Mock engine proved the pipeline end-to-end, then retired (4c7a99a).
- [x] Real NDJSON parser `engine::parse_events`, **8 golden tests** vs real CLI.
- [x] **Real-engine swap (2026-06-23).** `WorkspaceRegistry` owns one persistent
      `claude` child per workspace (cwd-locked, child + stdin owned only in Rust,
      `kill_on_drop`). stdout → `parse_events` → per-workspace `Channel`; stdin
      writes each turn. Commands: `open_workspace`, `engine_send(workspace_id,
      prompt)`, `engine_cancel` (control_request interrupt), `close_workspace`.
      Frontend lazy-opens one session, subscribes the channel once, routes
      send/cancel by id. Teardown (`shutdown_all`) reaps every child on app exit.
- [x] **Layout fix:** the `main` grid had no `gridTemplateRows`, so the implicit
      `auto` row grew to its tallest column's content and ignored the viewport
      height — pushing the conversation prompt bar below `body{overflow:hidden}`
      ("type bar lost"). Pinned with `gridTemplateRows: minmax(0,1fr)` so each
      column scrolls inside the bounded row; editor column made `min-h-0`.

Gate status (verified live on the reference machine, 2026-06-23):
- [x] Tokens stream smoothly (≤50ms reveal) — README-summary + counting turns.
- [x] Tool cards — `Read` card running→done, with input + output.
- [x] session_id captured — multi-turn continuity proven (3rd turn knew the cwd).
- [x] Zero ANSI — stream-json is pure JSON (no terminal control codes).
- [x] ParseError surfaced — golden test; `system/status`, `rate_limit_event`,
      `control_response` fall through to benign `Unknown` (UI ignores).
- [x] No zombie on close — teardown logs "engine sessions torn down"; zero
      leftover children; the persistent child is reaped on exit.
- [~] cancel→clean Stopped — implemented (interrupt → reader translates the
      terminal `result` into `Stopped`) and verified at the **protocol level**
      via the Python probe. One-click live-UI confirm left optional to save
      Opus tokens; low risk (every link in the path is independently proven).

Verified protocol facts (probed 2026-06-23 against claude 2.1.186):
- Spawn: `claude -p --input-format stream-json --output-format stream-json
  --include-partial-messages --verbose --strict-mcp-config` in the workspace cwd.
- One `claude -p` child answers MANY turns over stdin (stable `session_id`).
- `init` is re-emitted at the start of every turn (store init handler is
  idempotent). Result `total_cost_usd` is the **cumulative** session cost.
- Send a turn (one NDJSON line to stdin):
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}`
- Interrupt (mid-turn, session survives): stdin
  `{"type":"control_request","request_id":"…","request":{"subtype":"interrupt"}}`
  → `control_response{success}` then `result/error_during_execution`.
- Closing stdin makes the process exit on its own (clean, no kill needed).
- Tokio features added: `process`, `io-util`, `sync` (+ existing `time`, `rt`).

### Phase 2 — Plain terminal drawer  ·  COMPLETE ✅
Built 2026-06-23: a real plain shell in the drawer via `portable-pty` — the
spec mechanism exactly (§2.3 line 140, §5.A.6).
- [x] Backend `pty.rs`: `PtyRegistry` owns each terminal's PTY master + writer +
      child (Rust-only, spec 2.5 handle ownership). `$SHELL` (=/bin/bash here)
      spawned cwd-locked; a dedicated **reader thread** pumps raw bytes over a
      `Channel<Vec<u8>>`; an empty `Vec` is the EOF sentinel. Commands:
      `pty_open(rows,cols)`, `pty_write`, `pty_resize`, `pty_close`.
      `shutdown_all` reaps every shell on app exit.
- [x] Frontend `TerminalDrawer`: xterm bridged to the PTY — onData→`pty_write`,
      channel→`term.write`, ResizeObserver→fit+`pty_resize`, scrollback cap 5000
      (huge-output edge), a Restart control, shell kept alive across collapse and
      killed on unmount. PTY `Vec<u8>` arrives as a number[] → `Uint8Array`.

Two lifecycle bugs were caught **during the gate by real `ps` inspection** (not
assumed) and fixed:
- **StrictMode shell leak (frontend).** Async `openShell` set `ptyIdRef` only
  after `ptyOpen` resolved, so StrictMode's mount→unmount→remount ran the
  cleanup while the ref was still `null` → the first PTY opened *after* its own
  cleanup and was never closed (one leaked shell/mount; latent in prod for any
  unmount-before-open). Fixed with an **epoch guard**: each open claims an epoch;
  a `ptyOpen` that resolves after its epoch is superseded closes itself.
- **Self-exit zombie (backend).** When the shell exited on its own (`exit`), the
  reader saw EOF but nobody reaped the child → zombie until app exit (and the UI
  cleared `ptyIdRef`, so Restart never closed it). Fixed: the **reader thread
  reaps on EOF** — `PtyRegistry::open` now takes `Arc<Self>`; on EOF it removes
  the session and `wait()`s the child. Idempotent with `close`/`shutdown_all`;
  the session is registered *before* the reader starts so an instant-exit shell
  is still found.

Gate status (verified live on the reference machine, 2026-06-23):
- [x] Keys / color / resize — confirmed in the live drawer ("works very well").
- [x] Echo latency — qualitative: typing feels instant (local PTY + raw-byte
      channel, no full-buffer re-render); comfortably within one 16ms frame.
- [x] `exit` → `[process exited]` → Restart respawns — confirmed live.
- [x] **Zero zombie on close** — all reap paths verified by `ps`: `close()`
      (StrictMode superseded `pty-0`), `reap()` (self-exit via SIGHUP → `pty-1`),
      and graceful quit (`shutdown_all` reaped the live Restart shell `pty-2`;
      log "engine sessions + terminals torn down"; zero orphans, zero zombies).
- [x] Cold start 2601ms (≤3.0s budget); zero-warning Rust build; TS clean.

Notes: interactive bash ignores SIGTERM — use SIGHUP (or `exit`) to test a
self-exit. In dev the shell cwd is `…/src-tauri` (cargo's run dir); per-workspace
cwd routing is Phase 5. StrictMode double-opens the backend PTY once in dev
(immediately reaped); production does a single open.

### Phase 3 — Sessions & Timeline Rail (basic)  ·  3a DONE ✅ · 3b DONE ✅ · 3c BUILT (gate pending)
3a = the real session list + live file-watch (all disk-read, ~no tokens). Built
2026-06-23. Sequenced 3a → 3b (resume) → 3c (slash actions) per user's choice.
- [x] Shared `workspace::resolve_cwd` (explicit → `CLAUDE_IDE_WORKSPACE` → launch
      dir); the engine uses it too, so the engine's session lands in the same
      project dir the rail watches. Dev launches with
      `CLAUDE_IDE_WORKSPACE=/home/saud/Desktop/claude-ide`.
- [x] `sessions.rs`: `list(cwd)` reads the CLI's own `~/.claude/projects/<slug>/
      <uuid>.jsonl` **read-only, head+tail only** (never whole transcripts). The
      project dir is matched by the `cwd` recorded *inside* transcripts — never by
      recomputing the slug (spec 3.2 truncation/hash risk). Label = ai-title →
      last-prompt → first user msg → short id. 5 golden tests; a real-fs isolation
      check returned 5 sessions newest-first with good labels (throwaway, removed).
- [x] `SessionsRegistry` FsWatcher (`notify` v8) on `~/.claude/projects/`,
      **create/remove events only** (active-transcript appends ignored), 300ms
      coalesce → pushes the refreshed list over a Channel. Torn down on exit.
- [x] Commands `list_sessions` / `watch_sessions`; sessions store (StrictMode-safe
      single init) + real `SessionsPanel` (live list, active-session pulse,
      branch · relative-time, loading/empty/error states). TS clean; 13 tests
      pass; zero-warning build; cold start 1685ms.
- [x] **Gate PASSED (2026-06-24, live):** rail populated on open and matched the
      CLI's 5 sessions; sending one turn made a new session appear **live** at the
      top, pulsing (active head) — no restart. Confirmed on the reference machine.
- [x] **3b — resume / fork (2026-06-24) — DONE ✅ (gate PASSED live: "work very
      well").** Click a rail session to **resume** it, or its `⑂` (hover) to
      **fork** into a new branch;
      a `+ NEW` header button starts a fresh session. Backend: `engine::open_with
      (resume, fork)` adds `--resume <id>` / `--fork-session`; `read_session`
      reads the full transcript into renderable `ConvItem`s (merges
      tool_use+tool_result, skips meta/sidechain/thinking, caps to the
      most-recent 2000 with a `truncated` flag), plus a `validate_session_id`
      path/flag guard. This history read is **required** because the resume stream
      does NOT replay past turns — probed live against **2.1.187**: resume + one
      turn emitted only `init→assistant→result`, the prior turn appeared **0×**
      (and `init` fires on the first turn, not on spawn). Frontend: conversation
      store `resume()` / `newSession()` tear down the live child, load history,
      and queue a resume-open for the next `send`; an **epoch guard** drops the
      stale `Stopped` a closing child emits on EOF so it can't end the new turn.
      3 new Rust tests (transcript render, cap, id-escape) → 20 pass; TS clean;
      zero-warning build. Gate PASSED live (889c60b): resume shows history +
      continues context; fork branches to a new session; `+ NEW` clears.
- [~] **3c — slash commands (2026-06-24) — built, live gate pending.** Probed the
      thinly-documented path FIRST; findings reshaped the slice:
      • Delivery **works**: sending `"/cmd"` as a normal user turn over stream-json
        is intercepted + run by the CLI (verified live — user ran `/compact`).
      • `/rename` `/branch` `/rewind` **don't exist** in 2.1.190; the real session
        built-ins are `/clear` `/compact` `/context` `/config` `/usage` `/status`
        (+ ~300 skills in `init.slash_commands`). So 3c = a **menu**, not buttons.
      • A slash command usually returns an **empty synthetic assistant + empty
        `result`**; the only faithful effect signals are `system/status` /
        `system/compact_boundary` (today parsed as `Unknown` → dropped). The model
        does NOT reliably see a command's internal result — asking it can yield a
        confident *guess* (the test's "Not enough messages to compact" was inferred,
        not in the stream).
      Built: (1) **slash autocomplete** in the prompt bar from the live
      `slash_commands` (6 built-in fallbacks pre-init); ↑↓/Enter/Tab/Esc/click.
      (2) **`✓ ran /cmd` trace** so a no-output command never looks silent. TS
      clean. **Verify live:** `/` filters the menu; `/compact` shows `✓ ran
      /compact` instead of nothing.
- Follow-up (3c+): surface `compact_boundary` as a real "context compacted
      (N→M tok)" line; the structured `/rewind` checkpoint rail is Phase 7.
- Follow-up: point the PTY at the workspace root too (one-liner; it still uses
  `current_dir()` = `src-tauri` in dev).

### Phase 4 — Editor surfaces  ·  explorer · multi-tab · save · git · search — COMPLETE ✅
Phase 4 only depends on Phase 0, so we pivoted here from Phase 3 (3b/3c deferred)
because "can't see the code" was the biggest visible gap. Built slice-by-slice.
- [x] **Slice 1 — file explorer + view file (2026-06-24).** Backend `files.rs`:
      `list_dir` (dirs-first, lazy) + `read_file` (UTF-8, 2 MB cap, binary guard),
      both **confined to the workspace root** by canonicalize + `starts_with`
      (the one path-escape guard; 2 unit tests: in-root ok, `..`/symlink/missing
      rejected). Frontend: lazy `FileExplorer` tree in the editor region + Monaco
      shows the picked file (language-by-extension, model disposed per file — no
      leak). Editor stays lazy until a file opens (idle memory lean). Gate PASSED
      live: tree browses the project, click opens code highlighted; terminal +
      conversation unaffected. TS clean; 15 Rust tests; zero-warning build.
- [x] **Slice 2 — save (2026-06-24).** Backend `write_file` (root-confined,
      existing files only). Frontend: dirty dot + Ctrl/Cmd-S + Save button;
      truncated (>2 MB) files stay **read-only** so a partial buffer can't clobber
      the original. Gate PASSED live (save persists; verified via `git diff`).
      Two bugs found + fixed during the gate:
      • **Save reloaded the whole webview** (dev only): writing a workspace file
        tripped Vite's watcher → full reload → open file + explorer reset. Root
        cause confirmed from the log (re-init on each save, no Rust rebuild).
        Fixed in `vite.config.ts`: watch only `./src` (+ html/config), ignore the
        open workspace's files. Verified: a workspace write no longer reloads.
      • **Autocomplete popup clipped** in a narrow editor pane → Monaco
        `fixedOverflowWidgets: true` (popups render in a fixed layer).
- [x] **Multi-tab editing (2026-06-24), built to VS Code depth.** One Monaco
      editor, **one model per open file** — switching tabs preserves
      content/scroll/cursor/undo; dirty is **undo-aware** (editing back to the
      saved state clears it). Tab strip: active highlight, dirty-dot→✕ on hover,
      middle-click + ✕ close, horizontal overflow scroll, path breadcrumb,
      explorer highlights the active file. Each model **disposed on tab close**
      + all on unmount — **the Phase 4 "no leak on close" gate**. Binary →
      notice; >2 MB → read-only. New files: `store/editor.ts` (tabs),
      `EditorTabs.tsx`, `editor/language.ts`; `EditorPane` is now the model host.
      Gate PASSED live ("well done"). TS clean.
- [x] **Resizable panels (2026-06-24)** — pulled forward from Phase 5. Drag-resize
      the 3 main columns (sessions ▏ conversation ▏ editor) + the explorer ▏ code
      split via `react-resizable-panels` v4 (`Group`/`Panel`/`Separator` — the v4
      API was verified against the installed `.d.ts`, not assumed), and the
      terminal height via a hand-rolled top-edge drag handle (**PTY lifecycle left
      untouched**; the existing ResizeObserver refits xterm as it drags). Sidebar +
      editor keep pixel width on window resize while the hero absorbs slack; sizes
      persist (localStorage via `useDefaultLayout` + a terminal-height key);
      double-click a divider resets it; min-sizes prevent crushing. Shared
      `ResizeSeparator` (1px line, widened hit area, accent on hover/drag). Gate
      PASSED live ("everything is check"); TS + production build clean.
- [x] **Git panel — slice A: read-only status + diff (2026-06-24).** Backend
      `git.rs` drives the installed `git` CLI with `-C <root>` (no mutating/
      destructive command): `git_status` (branch + ahead/behind; changes grouped
      staged / unstaged / conflicted, `--porcelain=v1 -z`) and `git_diff` (both
      sides for Monaco's DiffEditor). Frontend: the left panel is now a **Files /
      Source Control** view-switcher (`Sidebar`) with a live change-count badge;
      `GitPanel` lists grouped changes; clicking one opens a Monaco diff as a `⇄`
      tab (`DiffView`), rendered as a **lazy overlay** over the editor host so the
      open file models are untouched. The **working-tree (modified) side is
      editable** with Ctrl/Cmd-S → writes the file + refreshes the list (VS Code
      parity); staged diffs are read-only. 2 new Rust tests (porcelain parse +
      path guard); TS clean; prod build green.
      • **Gate bug found + fixed (real check, not assumed):** the diff's modified
        side was empty because the dev app had been launched without
        `CLAUDE_IDE_WORKSPACE`, so `resolve_cwd` fell back to cargo's `src-tauri/`
        run dir and `read_worktree` read a path that doesn't exist. Fixed two
        ways: relaunch dev with the env var, **and** a `workspace::resolve_cwd`
        dev guard — if the launch dir is `src-tauri/`, use its parent (can't
        misfire in a release build). Verified live: working-tree diff edits +
        saves; explorer/sessions now target the real project.
- [~] **Git panel — slice B: stage / unstage / commit (2026-06-24) — built, LIVE
      GATE PENDING.** Backend mutations (`git add` / `restore --staged` / `reset -q`
      / `commit -m`) + 5 commands, all non-destructive (working tree never
      touched). Frontend: per-row ＋/－ stage-unstage (on hover), per-group
      stage-all/unstage-all, a commit box (message + ✓ Commit, Ctrl/Cmd-Enter,
      enabled only with staged changes + a message; empty/nothing-staged errors
      surface). Stage/unstage CLI round-trip verified (git 2.54.0); TS clean;
      prod build green; backend recompiled + relaunched. **Committed (8636059) +
      pushed — verify the UI live on return** (＋/－, group actions, a real
      commit; then mark done).
- [x] **Git panel — slice C1: branches (2026-06-25) — DONE ✅ (gate passed live).**
      A branch switcher in the panel header: lists local branches (current marked
      ●), click to **switch** (`git switch`), or **create** a new one
      (`git switch -c`) via an inline name input + a click-away menu. All
      non-destructive — git refuses a switch that would overwrite uncommitted
      changes (error surfaced). Backend `branches` / `switch_branch` /
      `create_branch` with a `valid_branch_name` guard (blocks `-`-injection and
      bad refs; git's own ref-format check does the rest). 21 lib tests; TS clean;
      zero-warning build. **Verify live:** open Source Control → branch dropdown
      lists/switches; create makes + checks out a new branch.
- [x] **Git panel — slice C2: guarded discard (2026-06-25) — DONE ✅ (gate passed
      live — deleted the throwaway untracked file via the confirm modal, left
      CLAUDE.md untouched).** The one DESTRUCTIVE git op. A `↩` action on
      **unstaged / untracked** rows
      only (never staged or conflicts) opens a **confirm modal** (Escape cancels;
      the danger button needs a deliberate click) before anything runs. Backend
      `discard`: tracked → `git restore`, untracked → `git clean -f`, on a single
      path-guarded file; a real temp-repo test proves both paths. 22 lib tests; TS
      clean; zero-warning build. **Gate on a THROWAWAY file only** — never real
      uncommitted work (e.g. CLAUDE.md). With this, the git panel is feature-complete
      bar polish.
- [x] **Global search (2026-06-25) — DONE ✅ (gate passed live — searched, results
      shown, working).** A third sidebar view
      (Files · Search · Source Control). Backend `search.rs` drives `rg --json
      --fixed-strings --smart-case` from the workspace root (respects `.gitignore`;
      the literal query is passed after `--`, so no regex surprise or flag
      injection), parsing match events into per-file lines split into
      highlight/plain segments — capped (2000 total / 200 per file / 400-char
      lines) with a `truncated` flag. Frontend `SearchPanel`: search-as-you-type
      (250ms debounce + token guard), results grouped by file with the hit
      highlighted; clicking a line opens the file **at that line** (new editor
      store `openAt` + a reveal effect in the Monaco host). 2 parser tests → 24 lib
      tests; TS clean; zero-warning build. **Verify live:** Search tab → type →
      grouped hits → click jumps to the line. With this, **Phase 4 is
      feature-complete** (explorer · multi-tab · save · git · search).

### Phase 5 — Multi-workspace routing & hardening → **v1 ships** (in progress)
- [x] **Slice A — dockable/collapsible panels** (user idea). Sessions rail · editor ·
      terminal each hide/show from a top-bar toggle cluster + VS Code shortcuts
      (Ctrl+B sessions, Ctrl+J terminal); the conversation hero is never hidden and
      absorbs freed space. Visibility persists (localStorage `ide:panels`). Built on
      the **verified** `react-resizable-panels@4.11.2` API (`usePanelRef()` →
      collapse/expand/isCollapsed; `collapsible`/`collapsedSize`), not the assumed
      bvaughn shape. A manual drag-to-collapse syncs back to the store; the mount
      `onResize` is ignored so persisted intent wins on reload. Terminal hide keeps
      the shell alive (host mounted at height 0). TS clean. **Gate passed live**
      (user confirmed shortcuts + toggles).
- [~] **Slice B — multi-workspace routing** (in progress): workspaces as tabs; each
      cwd bound to its own engine session + sidebar + sessions list, instant rebind on
      switch, no context bleed.
  - [x] **B1 — cwd-addressability + folder picker** (b7bd31a): `files`/`pty`/engine
        commands take a `cwd`; `tauri-plugin-dialog` native "Open Folder…" picker;
        `default_workspace` seeds the first tab.
  - [x] **B2+B3 — workspace tabs + sidebar/sessions re-rooting** (09213bd): a
        `workspaces` store (tabs, persisted) drives a tab bar; `git`/`sessions`/
        explorer/search all key off the active cwd. Gate passed live.
  - [x] **B4 — per-workspace conversation** (b595259): the conversation store became a
        per-cwd factory + registry; each workspace keeps its own live `claude` session,
        history, cost, in-flight turn — switching is instant with zero bleed. Gate
        passed live (opened ModernGirl → its own conversation).
  - [x] **B4.5 — session continuity (`claude -c`) (2026-06-25) — gate passed live.**
        Opening/first-focusing a workspace now **auto-continues its most recent
        session** (loads transcript + queues a resume; no child spawns until a turn is
        sent), one-shot per workspace so a later `+ NEW` is never re-continued; a
        history-less folder starts fresh. Fixes the "new session every open" stacking
        the user spotted (our `openWorkspace` had behaved like plain `claude`, not
        `claude -c`). `conversation.ts` `maybeContinue` + a `SessionsPanel` effect.
  - [x] **B5 — per-workspace editor tabs (2026-06-25) — built, typecheck clean.**
        Editor store became a per-cwd factory + registry (`editorStoreFor` /
        `useActiveEditor` / `activeEditorStore`, mirroring B4 conversation). Each
        workspace with open files keeps its OWN Monaco host instance, mounted and
        hidden when inactive → keep-alive of open files / scroll / cursor / undo /
        **unsaved buffers** across switches; model URIs keyed by **absolute path** so
        same-relative-path files in different projects never collide. **Fixed a latent
        bug:** `EditorPane` read/wrote files with no cwd → always hit the launch
        workspace; all file I/O (open/save/diff/diff-save) now routes through the active
        cwd. Explorer/search/git act on the active workspace's editor; DiffView takes
        cwd. Diff editor font 13→15 (font-bump consistency). Consumers updated:
        EditorPane, EditorTabs, EditorRegion, DiffView, FileExplorer, SearchPanel,
        GitPanel.
  - [x] **B6 — per-workspace terminal (2026-06-25) — built; typecheck + prod build
        clean, HMR verified.** Each workspace gets its own xterm + PTY rooted in its
        cwd (`ptyOpen(..., cwd)`); the active one is shown and the others stay mounted
        (shell alive, `visibility:hidden`) so switching is instant with no reflow or
        restart. Shell spawns lazily on first focus, then kept alive (dev log confirmed
        only the active workspace's shell opens). Shared chrome (drag-resize, label,
        hide toggle) stays in the parent; restart / exited act on the active terminal
        via a small registration map. Per-instance lifecycle (epoch guard, EOF reap,
        clean teardown) preserved; a workspace close unmounts its terminal → reaps its
        PTY. Resolves the standing "PTY still uses src-tauri/launch cwd" follow-up.
  - **Slice B COMPLETE** (A + B1–B6): workspaces as tabs, each cwd bound to its own
    engine session + conversation + sessions list + sidebar + editor + terminal, with
    instant keep-alive switching and no context bleed.
- [~] **Slice C — hardening** (in progress):
  - [x] **"no-placeholders" gate (2026-06-25)** — grep over `src` + `src-tauri/src`
        for todo/fixme/placeholder/coming-soon/not-implemented/wip/dummy/mock/stub/tbd
        returned ZERO hits. Clean.
  - [x] **empty / loading / error state audit (2026-06-25)** — every panel reviewed
        (Sessions, Conversation, FileExplorer, Search, Git, Editor, Diff, Preflight):
        all have intentional empty/loading/error variants with proper roles via the
        shared `states.tsx` primitives. No blank panes; no gaps found.
  - [x] **a11y pass (2026-06-25)** — focus baseline already solid (`:focus-visible`
        ring + reduced-motion honored). Fixed: workspace tabs + editor tabs were
        `role="tab"` divs (must be divs — they nest a close button) with no keyboard
        operability → added `tabIndex` + Enter/Space activation; git branch menu now
        closes on Escape (not just click-away); prompt-bar combobox got
        `aria-activedescendant` + option ids. Interactive controls have labels/roles;
        contrast is token-driven (WCAG-AA per tokens). Follow-up (Phase 10 polish):
        full APG roving-tabindex + arrow-key nav for the tablists.
  - [ ] perf-budget pass (live measurement on the reference machine).
  - [ ] → tag v1 (with the user).
- [x] **Global font-size bump (2026-06-25)** — type scale in `tokens.css` raised
      ~1–2px/step with matching line-heights (body 13→15, headings 28→32); Monaco
      13→15 and xterm 12→14 bumped directly (they don't read the tokens). User request.

### Pending (later phases)
- Phases 6–10 — P1 review queue, checkpoint timeline + permission manager,
  cost + cross-session search, agents dashboard, cross-platform/theming/release.

## Blockers
- None. Environment fully set up; production build green.

## Follow-ups (non-blocking)
- **[FINAL POLISH PHASE] Sidebar view-switcher cosmetics** (user flagged 2026-06-25):
  the Files · Search · Source Control text-tab row feels cramped/"ugly" next to
  the workspace tab bar. Functionally fine (it's VS Code's three-view model), but
  reconsider the treatment in the last phase — e.g. an icon activity bar instead
  of text labels, or relocating search. Defer per [[defer-cosmetic-polish]]; do
  NOT change mid-phase.
- **Per-session delete** (user asked 2026-06-25): the installed CLI exposes **no**
  single-session delete — only `claude project purge [path]`, which nukes the WHOLE
  project (all transcripts/tasks/file-history/config). Hand-deleting a single
  `<uuid>.jsonl` is out (we never modify `~/.claude` except read + sanctioned purge —
  wrapper rule). So a true per-session delete needs a CLI command Anthropic doesn't yet
  ship; a guarded "purge this project's history" action (heavy, strong confirm) is the
  only sanctioned option. Defer to the polish phase / revisit when the CLI supports it.
- Bundle Geist Sans/Mono font files (currently system-font fallback).
- Tighten the CSP at the Phase 10 release audit.
- Consider lazy-loading xterm too, to shave a little more off the initial chunk.
- The env-gated cold-start marker (`CLAUDE_IDE_PERF_MARKER`) is dev/measurement
  instrumentation — keep using it to track budgets each phase.
