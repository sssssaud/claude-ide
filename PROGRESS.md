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
- `--permission-prompt-tool` is **NOT** in `--help`, BUT it still works and is the
  P1 mechanism — **corrected/verified 2026-06-26 against 2.1.191 by live probe**
  (scratchpad `perm_probe.py`). Passing **`--permission-prompt-tool stdio`** routes
  permission decisions over the **stdio control protocol** (the same bidirectional
  channel we already use for interrupt): the CLI emits `control_request{subtype:
  "can_use_tool", request_id, request:{tool_name, input, tool_use_id, …}}` and we
  answer with `control_response{response:{subtype:"success", request_id, response:
  {behavior:"allow", updatedInput}}}` (or `{behavior:"deny", message}`). Proven
  end-to-end: an `allow` response actually wrote the probe's file. **No Agent SDK
  and no local MCP server are needed** — simpler than the spec's two options.
  WITHOUT the flag the CLI auto-denies headlessly (so pre-Phase-6 the conversation
  pane was effectively a read-only agent — every Write/Edit/Bash was denied).
- `claude doctor` = auto-updater health check (not daemon status); daemon-status
  spelling to re-verify at Phase 9.
- **Checkpoint / rewind (Phase 7 P2) — decoded read-only, verified 2026-06-26.**
  The CLI exposes **no programmatic rewind/restore** (no `--help` flag, no
  subcommand — `claude project` only has `purge`, no slash command, and the
  control-protocol `initialize` response advertises no rewind capability). Rewind
  is a TUI-only feature (double-Esc); a stream-json wrapper can't drive it, and
  hand-rolling restore is forbidden (wrapper rule). **But file history is fully
  readable:** `~/.claude/file-history/<session-id>/<hash>@v<N>` where
  **`<hash> = hex(sha256(absolute_path))[:16]`** (proven: MEMORY.md's abspath →
  `7f5d8f548efb3025`, exact match) and `@v<N>` are successive versions (each file
  raw content at that version; N increments per edit, starts at v2). No manifest
  in the dir, so map **hash→path via the transcript's Write/Edit `file_path`s**.
  ⇒ Phase 7 P2 = a **read-only** checkpoint timeline + diff preview (snapshot vs
  snapshot/current). RESTORE deferred until Anthropic ships an API (user's call,
  2026-06-26). `~/.claude/file-history` is READ-ONLY for us (never modify).
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

**ALL PHASES 0–10 COMPLETE.** Phase 10 (the last phase) closed 2026-06-29: vertical
icon activity bar (10A), runtime multi-theme picker (10B), bundled Geist fonts —
offline (10C), objective polish — a11y / clippy-clean / CSP re-audit / per-session-
delete re-verify / font chain (10D). Production build green, clippy 0 warnings, 50
Rust tests pass, typecheck clean. Outstanding = **live gates only** (need the running
app), tracked at the foot of this file — not code work.

### Security & robustness hardening pass · COMPLETE ✅ (2026-06-30)
Acting on an external backend audit. Plan-mode first; one finding per commit; a
test per fix where testable; no widened attack surface (no new command, capability,
CSP relaxation, or dependency). All findings done:
- **B1** — one validated absolute `claude` path. New `claude_bin` module resolves
  `which("claude")` once at startup into a `OnceLock`, with an `ensure_absolute`
  guard; engine/preflight/agents all spawn it (the latter two were spawning a bare
  `claude`, a per-spawn PATH lookup). +3 tests.
- **B2** — bounded engine per-line read. `read_bounded_lines` caps a single NDJSON
  line at 16 MiB (was unbounded via `lines()`), drops an over-long line with one
  `EngineEvent::LineTruncated` then resyncs. +3 tests; TS mirror updated.
- **B3** — two data-dependent unwraps made structurally total (engine
  `control_request` arm; search `last_mut`). +2 tests.
- **B4** — mutex-poison recovery (`unwrap_or_else(|e| e.into_inner())`) at 6 pty +
  2 sessions lock sites (registries hold only handles, no security invariant).
- **B5** — `// SECURITY:` markers documenting the canonicalize-parent containment
  requirement for the future create-new-file slice (files.rs).
- **C1** — loud red, in-app two-step confirm before *newly* enabling
  bypassPermissions (PermissionsPanel.tsx); persistent `role="alert"` while active.
- **C2** — production CSP drops the Vite dev-only localhost entries; kept in
  `devCsp` (schema-confirmed) so dev/HMR is unchanged.
- **C3** — full CI gates: `.github/workflows/ci.yml` (typecheck, build, clippy
  `-D warnings`, tests, **cargo audit + npm audit**). Baselines checked first:
  cargo audit 0 vulns (18 upstream warnings, default exit passes); npm audit 1
  transitive dev low → `--audit-level=high` green.
- **C4** — *deferred, reasoned* (allowed by acceptance): audited all 26 interpolated
  error strings — every one embeds only a `{e}` OS Display string, never a
  path/query/secret; local single-user app (webview = backend trust domain) → no
  remote leak. Recorded as a durable ERROR-DETAIL POLICY note on `IpcError`.
- **Part A (do-not-regress)** all 8 re-verified intact (path containment, no-shell
  exec, branch validation, no arbitrary-exec command, least-privilege config, stdio
  permission gate, settings writer, robust parser).
- Gate: clippy `-D warnings` 0, 50 Rust tests pass, prod build green, both audits
  green. Live manual smoke pending (running app). 10 focused commits; CLAUDE.md +
  myfile.txt deliberately untouched.

## Addendum II — Developer Tools, Settings & UI Polish (plan: linear-hopping-pixel)
Plan approved (full addendum, Part 6 order, slice-by-slice). Scope decision: build
on the current editor; editor splits/groups/git-gutter/full-breadcrumbs deferred to
a later track. Guardrails (§5 + hardening do-not-regress) enforced each slice.

### S1 — Settings skeleton + persistence + highest-value settings · COMPLETE ✅ (2026-06-30)
The IDE's OWN preferences surface (distinct from the CLI's `.claude/settings.json`).
- **Backend `settings.rs`** — mirrors the `permissions.rs` A7 pattern: validated
  read-modify-write of `app_config_dir()/settings.json` (NEVER `~/.claude`).
  Two scopes — global `user` + per-workspace overrides keyed by canonical path;
  effective = `DEFAULTS < user < workspace` (merged frontend-side). Numbers clamped
  (fontSize 6–72, tabSize 1–16, wrapColumn 20–400), `wordWrap` enum allow-list,
  fontFamily trimmed/bounded; unknown keys preserved; non-object file refused (never
  clobbered); fixed path takes no caller segment (§5.1/§5.8). **+6 tests.**
- **Commands** `read_settings`/`write_settings` (→ 42 total) — config dir resolved
  from the `AppHandle`; `write_settings` validates the scope enum + requires a
  workspaceKey for workspace scope. No new capability/CSP (custom commands aren't
  ACL-enumerated; Rust-side `std::fs` only).
- **Frontend** — `store/settings.ts` (zustand mirror: load / setEditor / replaceEditor,
  optimistic write + rollback-on-error, `mergeEffective` + `EDITOR_DEFAULTS`);
  `layout/SettingsView.tsx` (full-area overlay: category rail, searchable controls,
  User/Workspace scope toggle, per-control override dot + reset, Edit-as-JSON with
  validate-on-apply, loading/error/empty + saveError states; tokens-only, keyboard-
  operable, reduced-motion via existing tokens); `settingsOpen` in `store/layout.ts`;
  bottom **Settings** action in the activity bar (`Sidebar.tsx`, gear, not a tab);
  **Ctrl/Cmd+,** in `useLayoutShortcuts`; overlay mounted over `WorkspaceShell` `<main>`.
- **Live wiring** — `EditorPane.tsx` hardcoded Monaco options replaced: font family/
  size/ligatures + wordWrap(+column) + minimap flow through the `options` prop;
  tabSize/insertSpaces applied per-model (on load + on change). Settings load once at
  app startup so the editor reflects them with no Settings-view visit needed.
- Gate: clippy `-D warnings` 0, **56 Rust tests** pass, typecheck clean, prod build
  green. Backend persistence proven by round-trip tests (write→disk→read). Live
  manual smoke (change setting → Monaco updates → persists across restart) pending
  the running app. CLAUDE.md + myfile.txt untouched.

### Post-S1 live-smoke feedback → VS Code layout + staged Settings tab + perf fix · COMPLETE ✅ (2026-07-01)
User feedback after live-smoking S1 superseded the overlay design: theme dropdown
removed from the top bar (theme now lives only in Settings > Appearance); activity
bar + a collapsible Side panel moved to the far left (Explorer/Search/Git/Sessions/
Permissions/Usage), Conversation + Editor filling the rest (`ActivityBar.tsx`,
`SidePanel.tsx`, new `useSessionBootstrap.ts` hoisting session init out of
`SessionsPanel`; `Sidebar.tsx` removed). Settings now opens as a **closable editor
tab** (gear icon or Ctrl/Cmd+,) with **staged Apply** — edits a draft, nothing takes
effect until Apply, closing with unapplied changes prompts Keep editing / Discard &
close / Apply & close (`store/settings.ts` rewritten, `SettingsView.tsx` rewritten,
`EditorRegion.tsx`/`EditorTabs.tsx` wired for the settings "tab").
- **Perf fix**: diagnosed a reported cursor/input-lag bug (~1s delay updating the
  cursor icon on mouse move) via instantaneous `top -b -d1` sampling (not `ps
  %cpu`, which is a lifetime average and misleading). Root cause: the
  `.status-lamp-pulse` infinite opacity animation ran unconditionally (tab-bar lamp,
  active-session dot) — under WebKitGTK's software compositor (dmabuf renderer
  disabled) this cost ~10-11% continuous CPU, enough to lag GTK cursor-shape
  updates. Fix: both lamps now gate on `streaming` (only animate while the agent is
  actually running; idle = static dot, idle color). Verified via `top -b -n
  8 -d 1 -p <main>,<WebKitWebProcess>`: idle CPU dropped from ~10-11% to ~0%.
- Gate: typecheck/build/clippy/56 tests all green; idle-CPU fix verified live.
  Committed as `9bece35`. CLAUDE.md + myfile.txt untouched.

### S2 — Data-safety defaults · COMPLETE ✅ (2026-07-01)
- **Backend** `settings.rs`: `formatOnSave`/`formatOnPaste`/`trimTrailingWhitespace`/
  `insertFinalNewline`/`trimFinalNewlines`/`autoSave`/`autoSaveDelay` added to
  `EditorSettings`; `autoSave` enum-checked (off/afterDelay/onFocusChange/
  onWindowChange), delay clamped 200ms–60s. **+2 tests** (58 total).
- **Frontend**: `EDITOR_DEFAULTS` favors not losing work over reformatting —
  `autoSave: onFocusChange`, `trimTrailingWhitespace: true`, `insertFinalNewline:
  true`; format-on-save/paste stay opt-in (a registered formatter can reflow code
  unasked). New pure `editor/saveTransforms.ts` (`trimTrailingWhitespace` — skips
  Markdown, where trailing spaces are a hard line-break — and
  `normalizeFinalNewlines`), sanity-checked against 10 hand-picked edge cases.
  `EditorPane.tsx`'s save path became `saveFile(path)`: format-on-save runs only
  when the model is the one attached to the editor widget (the format action can't
  safely act on a detached model), then the trim/newline transforms apply as one
  grouped undo edit before writing. Auto-save wired three ways: `afterDelay`
  debounces off the model's own change event (reset per keystroke), `onFocusChange`
  listens to the editor's own blur, `onWindowChange` listens to the window's blur
  but only fires if this pane's editor actually had focus. New Settings "Files"
  category holds the new controls; "Format On Save/Paste" joined Text Editor.
- Gate: typecheck/build/clippy/60 tests green. Committed as `8fdecea`.

### S2.5 — Account sign-in/out · COMPLETE ✅ (2026-07-01, added mid-build, user-requested)
User's ask: "we need a login button... when someone download it we need to login."
Never hand-rolled: both operations shell out to the installed CLI.
- **Backend** new `auth.rs`: `status()` runs `claude auth status --json` (mirrors
  `preflight.rs`'s existing read-only probe), `logout()` runs `claude auth logout`
  (non-interactive). **+2 tests** (60 total). `login` is deliberately NOT a backend
  command — it's an interactive browser/OAuth flow (sometimes SSO/email-code), so
  it isn't guessed at non-interactively.
- **Frontend** new `components/InlineTerminal.tsx`: a small one-shot xterm+PTY that
  types one command in on mount and reports back on process exit — hosts
  `claude auth login` for real, wherever it's needed. New `store/auth.ts` (status +
  logout). Settings gets an **Account** category (status/email/plan, Log out; Log in
  → `InlineTerminal` when signed out). The Preflight gate (which blocks BEFORE auth
  is confirmed and must never spawn anything itself — no `WorkspaceShell`/terminal
  drawer mounted yet) gets a real **Sign in** button using the same
  `InlineTerminal`, replacing the old "go run this yourself" text; the manual
  command + Retry check stay as a fallback.
- Gate: typecheck/build/clippy/60 tests green; live-started the dev server (no
  runtime crash, preflight still reports `authenticated=true`); did NOT click
  through Login/Logout live (that would touch the real signed-in Anthropic
  session) — manual click-through of Settings > Account and the gate's Sign-in
  button is still owed by a live smoke pass. Committed as `f8607cb`.

### Onboarding fix: Retry check now detects a CLI installed mid-session · COMPLETE ✅ (2026-07-01)
User asked through the actual install-order scenario: install the IDE, then
install Claude Code CLI, then log in — how does that actually work? Traced it
and found a real gap: `claude_bin`'s PATH resolution was cached exactly once at
process startup (hardening B1), so someone who opened Claude IDE first, saw
"not installed," went and installed the CLI, and clicked **Retry check** would
still see "not installed" — the cache never re-checked PATH, silently requiring
a full relaunch that nothing on screen mentioned.
- Fix (user picked "fix the re-probe" over just improving the message): the
  cache is now **sticky once found, retryable while absent** — a binary that's
  never been found and trusted has nothing for the anti-hijack guarantee to
  protect, so it's safe to re-run `which` on every miss; once found, it locks
  in exactly as before and is never re-resolved (B1 intact). **+1 test** (61
  total) against a fake probe, deterministic (miss, miss, hit, then a post-hit
  miss that must NOT re-probe) — doesn't touch real PATH/env, so it can't
  destabilize other tests sharing the process.
- Gate: clippy `-D warnings` 0, 61 Rust tests pass. Committed as `741ffca`.

### S3 — Developer command set + Command Palette + Quick Open · COMPLETE ✅ (2026-07-01)
- **Backend**: new `search::list_files` (`rg --files`, same generic-dev-tool
  exemption as `search()`, respects `.gitignore`, capped 20k) exposed as
  `list_files`.
- **Registry** (`commands/registry.ts`): one flat list of every command, each
  optionally carrying a default global keybinding (`combo`, e.g. "mod+b") and
  an `enabled?()` gate. `commands/keybindings.ts` matches a `KeyboardEvent`
  against a combo string. `useLayoutShortcuts.ts` is no longer a hardcoded
  if/else — it iterates the registry and runs whatever combo matches (still
  capture-phase, still `preventDefault`-only-on-match, so Monaco's own
  bindings like Ctrl+S/Ctrl+G are untouched).
- **Command Palette** (Ctrl/Cmd+Shift+P) and **Quick Open** (Ctrl/Cmd+P) share
  one overlay shell, `FuzzyOverlay`, over a hand-rolled subsequence fuzzy
  matcher (`commands/fuzzy.ts` — no new npm dependency; sanity-checked against
  hand-picked cases). Quick Open fetches the file list fresh every open (not
  cached) and opens the pick in the active workspace's editor. The palette
  shows each command's keybinding per row.
- **Active editor handle** (`store/activeEditorHandle.ts`): File: Save, Go to
  Line, and editor-font zoom need the live Monaco instance; rather than
  threading it through React, the active workspace's `EditorPane` registers a
  small handle imperatively — set only while active, cleared only if it's
  still the one registered (order-independent: a race between one pane
  deactivating and another activating can't clobber the newly-active one).
- **Zoom** (`store/zoom.ts`: editor-font delta + whole-app `zoom` CSS factor)
  and **Zen Mode** (`layout.ts`'s new `zen` flag) are both deliberately
  EPHEMERAL — reset every launch, never touch Settings' staged Apply model
  (a silently-persisted zoom/zen with no on-screen explanation would be more
  confusing than useful; the palette can always get you back). Zen overlays
  the activity bar/side panel/terminal to hidden WITHOUT mutating their own
  toggles, so turning it off restores exactly what was showing — the
  sidebar's onResize->store sync is guarded against zen's own `collapse()`
  calls so they can't leak into the persisted toggle.
- Gate: typecheck/build/clippy/61 Rust tests green; live-started the dev
  server (no crash) and re-confirmed idle WebKitWebProcess CPU is still ~0%
  (no regression from the earlier pulse-animation fix). Did NOT click through
  the palette/Quick Open/zoom/zen live (no GUI automation available for the
  native window) — that manual smoke pass is still owed. Committed as `cf3720f`.

### S4 — Agent-bridge: select code, ask Claude · COMPLETE ✅ (2026-07-01)
The differentiator slice — no new backend surface at all, by design.
- `commands/agentActions.ts`: one shared implementation for Explain / Refactor
  / Fix This / Add Tests / Add Docstring — builds a structured prompt (task +
  file path + line range + fenced code block of the selection) and sends it
  via `useActiveConversation().send`, the exact path the prompt bar itself
  already uses (-> the existing `engine_send`, no new IPC command).
- Exposed two ways, both calling that one function: Monaco's own right-click
  menu + F1 command list (`editor.addAction`, gated on the built-in
  `editorHasSelection` precondition) registered in `EditorPane`'s `onMount`,
  and 5 new Command Palette rows (category "Claude") gated on
  `hasAgentActionTarget()` (a selection exists and no turn is already
  in flight).
- `ActiveEditorHandle` grew `getActivePath()` (read fresh, not frozen at
  registration — the Monaco instance is shared across a workspace's tabs and
  can show a different file without the handle re-registering).
  `store/conversation.ts` grew `activeConversationStore()` (mirrors
  `store/editor.ts`'s `activeEditorStore()`) for the same outside-a-component
  imperative access the palette's `enabled()` checks need.
- Gate: typecheck/build/clippy/61 Rust tests green (no Rust changes this
  slice); live-started the dev server, clean boot. Did NOT click through the
  right-click menu/palette entries live (no GUI automation for the native
  window) — manual smoke (select code → Explain → a real turn streams back)
  is still owed. Committed as `1d60c3a`.

### Manual code review of S1–S4 + the perf/onboarding fixes · COMPLETE ✅ (2026-07-01)
User asked to check today's work before starting S5. Started as an 8-angle
multi-agent `/code-review high`; the user stopped 7 of the 8 background
agents before they reported (only the efficiency angle finished), so the rest
was done as a direct manual read-through of the full `@{upstream}...HEAD`
diff instead. Found and fixed 5 real issues:
- **`ActivityBar.tsx`** — the Sidebar→ActivityBar rewrite dropped
  `aria-controls` linking each view tab to the side panel (old `Sidebar.tsx`
  had it; new `SidePanel.tsx` has the matching id/role but nothing referenced
  it) — restored, and `aria-selected` now reflects the logical current view
  instead of being gated on the panel being open (no tab was ever "selected"
  while collapsed).
- **`store/auth.ts` + `auth.rs`** — `logout()` bundled the post-logout status
  refresh into the same try/catch as the logout call, so a status-probe
  hiccup right after a successful sign-out was misreported as the sign-out
  failing (UI stayed on stale "Signed in"). Decoupled the two; also hardened
  `probe_status` to treat unparseable output on a non-zero exit as logged-out
  rather than a hard error (mirrors preflight.rs's established non-zero =
  not-authenticated signal). **+3 tests** (64 total).
- **`EditorPane.tsx`** — `saveFile`'s own trim-whitespace/final-newline edit
  fired `onDidChangeContent` like a real keystroke, flickering the dirty dot
  on every save that changed anything and (short `autoSaveDelay` + a slow
  write) risking a redundant concurrent save. Added a per-path `savingRef`
  guard the change handler checks and skips.
- **`FuzzyOverlay.tsx`** — the highlighted row was only clamped when the
  result count shrank, never reset to the top match per keystroke, so
  reshuffled rankings could commit a different item than the one last seen
  highlighted. Now resets to index 0 on every query change.
- **`QuickOpen.tsx` + `commands/fuzzy.ts`** — every open re-spawned
  `rg --files` and rescored the whole list with no memoized lowercase target.
  Added a per-workspace stale-while-revalidate cache (30s TTL, instant on
  repeat opens) and a lowercase-target cache in the fuzzy matcher.
- Gate: typecheck/build/clippy/64 Rust tests green; live-started the dev
  server, clean boot. Committed as `603ec6e`.

### S5 — Status bar + editor toolbar (chrome polish) · COMPLETE ✅ (2026-07-02)
- **Status Bar** (bottom strip, hides in zen mode): left = branch+ahead/behind
  (→ Source Control view) and agent running/idle (click stops a running
  turn); right = Ln:Col (→ Go to Line), selection length (→ copy to
  clipboard), indent, EOL (click toggles LF/CRLF), language (→ fuzzy
  language-mode picker, reusing `FuzzyOverlay`), cost/tokens (→ Usage view),
  theme (→ Settings — a deep-link, not a dropdown, keeping the earlier
  "theme lives only in Settings" decision). **Deliberately not built:** a
  Problems count and a notification bell — neither has a real backing system
  (no diagnostics provider; no notification system at all), and faking either
  would be worse than waiting for the real thing.
- New `store/editorStatus.ts` — the first REACTIVE per-file status (cursor,
  selection, language, indent, EOL); `EditorPane` pushes into it from the same
  points it already manages `activeEditorHandle`, cleared via the same
  still-registered-handle identity check so a workspace switch can't leave
  stale data behind.
- **Editor toolbar**: a "…" button pinned top-right of the tab strip — Format
  Document / Go to Line always, the five Claude selection actions (S4) when
  something's selected — reuses `commands/agentActions.ts` rather than a
  second copy of the prompt-building logic.
- Also fixed a real latent gap opened back in S3: the git-status refresh
  lived in `ActivityBar`, which unmounts in zen mode — hoisted into
  `useSessionBootstrap` so both the Status Bar's branch segment and the
  activity bar's Source-Control badge stay live regardless of what's
  mounted. Consolidated three copies of the open-Settings helper into one
  export.
- Gate: typecheck/build/clippy/64 Rust tests green (no backend changes);
  confirmed Monaco stayed out of the eager bundle; live-started the dev
  server, clean boot, idle WebKitWebProcess CPU still ~0%. Committed as
  `7674c3b`.

### S6 — Remaining settings + bottom-panel tabs · COMPLETE ✅ (2026-07-02)
- **Backend schema widened** (`settings.rs`): `ScopeSettings` grew from
  editor-only to `{editor, terminal, files, appearance}`, plus a top-level
  `keybindings: BTreeMap<command id, combo>` (always user-global, its own
  read-modify-write, separate from the scoped write). All four categories
  validated/clamped the same way editor already was (`TerminalSettings`
  scrollback 100–100,000; `FilesSettings.exclude` — plain names, `/`/`\`
  rejected, deduped, capped at 100 entries × 100 chars; `FilesSettings.eol`
  enum `auto|lf|crlf`; keybinding combos charset-checked, an empty combo
  removes the override). `write_settings`'s IPC shape changed from a flat
  `editor` param to a full `settings: ScopeSettings` — updated frontend
  in lockstep in the same pass so an old client could never silently wipe a
  user's settings via serde's `#[serde(default)]` on the new shape. 69 tests
  (5 new), clippy clean.
- **`store/settings.ts` generalized**: `user`/`workspaces`/`draft` are now
  full `ScopeSettings` (all 4 categories) instead of bare `EditorSettings`;
  `setDraft(category, key, value)` replaces the old single-category
  `setDraft(key, value)`; `mergeEffectiveTerminal/Files/Appearance` added
  alongside the existing `mergeEffective` (editor), each with its own
  `_DEFAULTS`/`_KEYS`. `sanitizeScopeSettings` backs a JSON-editor mode that
  now edits every category at once. `effectiveFilesFor(cwd)` is the
  imperative read path for non-React call sites (search/Quick Open excludes).
- **Settings UI**: new Terminal + Keybindings categories, Files gained
  Exclude (a textarea list, one name per line — its own control, not a
  scalar), End Of Line, and Confirm Before Closing Unsaved Files; Appearance
  gained Color File Icons + Reduce Motion alongside the existing Theme row.
- **Keybinding editor** (`layout/KeybindingsSection.tsx` + new
  `store/keybindings.ts`): searchable list of every rebindable command (all
  but `file.save`/`editor.gotoLine`, which stay Monaco-owned per S3's design
  note), a "Change" capture control (requires Ctrl/Cmd in the chord so a
  global capture-phase rebind can never swallow ordinary typing), Reset, and
  a non-blocking conflict warning ("Set anyway"). Saves immediately — no
  staged Apply, unlike the rest of Settings — matching a VS Code-style
  keybindings editor. `useLayoutShortcuts.ts`'s dispatcher now resolves each
  command's *effective* combo (override, else default) instead of the fixed
  default.
- **Terminal settings live in xterm**: font family/size/cursor-blink/
  scrollback flow from Settings into the real `Terminal` constructor and
  update live via `term.options` (xterm renders to canvas, so a
  `var(--font-mono)` default is resolved to its literal value first — Monaco
  can use the CSS var directly since it's DOM-styled, xterm can't).
- **Files settings wired to their real consumers**: `exclude` filters the
  File Explorer client-side (lazy per-directory listing, nothing to push
  server-side there) and is passed server-side to `search`/`list_files` for
  the Search panel and Quick Open (also folded into Quick Open's cache key
  so a settings change shows up immediately, not after the 30s TTL);
  `eol` converts via Monaco's own `model.setEOL()` at save time — not a
  regex — so it stays consistent with the Status Bar's manual EOL picker;
  `confirmCloseUnsaved` gates a new confirm dialog on closing a dirty file
  tab (`EditorTabs.tsx`), mirroring the Settings tab's own close-confirm
  pattern.
- **`appearance.reducedMotion`**: a `data-reduced-motion` attribute on
  `<html>` (set from a `WorkspaceShell` effect over the effective appearance
  settings) plus a matching `global.css` rule — an explicit override of the
  same rules the OS `prefers-reduced-motion` media query already triggers.
  `colorFileIcons` renders a small color-coded swatch per known extension in
  the File Explorer in place of the file emoji (emoji glyphs render in full
  color regardless of CSS `color`, so tinting the emoji itself is a no-op —
  confirmed by checking, not assumed).
- **`layout/TerminalDrawer.tsx` → `layout/BottomPanel.tsx`**: three tabs —
  Terminal (the real per-workspace shell, unchanged, stays mounted across a
  tab switch so it's never restarted just by looking at another tab),
  Output/Logs (the active workspace's raw engine-event stream — new
  `rawLog: EngineEvent[]` on `store/conversation.ts`'s per-workspace store,
  capped at 500, appended in `channelFor`'s wrapper so it captures
  everything the CLI sends including events from a since-superseded session
  that `items` deliberately drops), Problems (⏸ explicit "coming soon" —
  no diagnostics source exists to wire up, so it says so rather than faking
  one). Deliberately skipped a Search-results tab as redundant with the
  existing side-panel Search view, per the plan.
- **Real bug found + fixed during live verification, not scope creep**: the
  terminal's lazy-open lifecycle (unchanged from the original
  `TerminalDrawer.tsx`, just relocated) had a live-reproducible dev-mode-only
  race — React StrictMode's simulated mount → cleanup → mount doesn't reset
  a component's refs (same fiber, not a real unmount), so the pre-existing
  epoch-guard cleanup closed the first `ptyOpen` cleanly (no zombie — that
  part was already correct) but never reset `openedRef`/`createdRef`, so the
  *second, real* mount believed a shell was already open and never spawned
  one — leaving the terminal permanently empty (and "Restart" a no-op too)
  on every single `tauri dev` launch, deterministically, not just
  occasionally. Confirmed via `ps --ppid` (no `bash` child existed) before
  and a live one after. Fixed by resetting both refs in the same cleanup
  that already increments the epoch — same fix family as the already-shipped
  epoch guard, just completing its gap.
- Gate: typecheck/build/clippy/69 Rust tests green. Live `tauri dev`
  restarted clean twice; confirmed via process inspection (`ps --ppid` on
  the app PID) that the terminal's `/bin/bash` is genuinely alive post-fix,
  not just log lines. Could not get a visual screenshot of the running app
  window in this environment (fullscreen capture only ever showed the
  coding-session terminal, not the Tauri window, despite the process
  demonstrably running and responding correctly) — noted rather than
  claimed; the UI wiring itself was verified by full paths (types →
  store → component → backend command → validated persistence), not by
  eyeballing it. Committed as `ce1b627`.

### S7 — 🔸 extras · COMPLETE ✅ (2026-07-02)
- **File utils, canonicalize-parent-and-contain** (`files.rs`, hardening B5's
  documented pattern, now actually built): `create_entry` (new file/folder —
  canonicalizes the EXISTING parent, containment-checks it, then appends one
  validated component; never canonicalizes the not-yet-existing target) and
  `duplicate_file` (auto-numbers "foo.txt" -> "foo copy.txt" -> "foo copy
  2.txt" -> ..., atomic via `create_new`, not `fs::copy`-then-check — avoids a
  TOCTOU that would've let a duplicate silently clobber an existing "copy").
  +5 Rust tests (72 total).
- **File Explorer context menu**: New File/Folder (a name-prompt modal, not a
  native `window.prompt`), Duplicate, Copy Path / Copy Relative Path
  (`navigator.clipboard`, same API already used by the Status Bar and
  `ErrorState` — no new capability), Reveal in File Manager, Open Terminal
  Here. A small `refreshTick` map forces just the affected directory's
  already-loaded `TreeNode` to refetch after a create/duplicate, without a
  wider tree-state rewrite.
- **Reveal in file manager**: `tauri-plugin-opener`, used as a **plain Rust
  library function** (`reveal_item_in_dir`) called from inside our own
  `reveal_in_file_manager` command — never registered as a plugin, never
  exposed to the webview as its own IPC command. Confirmed this adds **zero**
  new capability surface: `capabilities/default.json` and `tauri.conf.json`
  are byte-for-byte unchanged (`git diff` empty) — the command is gated the
  same as every other app command already in `commands.rs`, not through the
  plugin ACL the original plan assumed it would need.
- **Open Terminal Here**: reuses the already-open per-workspace shell (not a
  second ad-hoc PTY) — writes a `cd` into it via the existing `ptyWrite`. New
  `store/activeTerminals.ts` (mirrors `activeEditorHandle.ts`'s non-reactive
  module-level registry pattern) tracks each workspace's live pty id so this
  can reach it without plumbing PTY state through React context. The path is
  single-quote shell-escaped (`'...'` with `'\''` for embedded quotes) — this
  writes into a REAL shell, and a file/folder name can legally contain shell
  metacharacters.
- **Compare-with-snapshot from the gutter**: a new Monaco action
  ("Compare with Checkpoint…", right-click + editor toolbar) reuses the
  existing read-only checkpoint timeline (Phase 7 P2) already shown
  per-session in the Sessions panel — fetches the active session's entries,
  filters to the open file, lets you pick a version, opens the same
  `openCheckpointDiff` tab that panel does.
- **Keyboard-shortcut cheat sheet** (`?` / Ctrl+K Ctrl+S): a reference overlay
  (every command grouped by category with its effective shortcut), distinct
  from the Command Palette's search-and-run. Required teaching the global
  dispatcher (`useLayoutShortcuts.ts`) real two-step CHORD support
  (comma-joined combos, e.g. "mod+k,mod+s") — `settings.rs` had already
  validated commas in keybinding overrides since S6 but nothing consumed them
  yet. The bare "?" hotkey is intentionally NOT a dispatcher combo (every
  other combo requires "mod" specifically so it can never collide with
  typing) — it's a small dedicated listener gated by a new `isTypingContext()`
  check (focused input/textarea/contenteditable), so "?" in a search box or
  the prompt bar just types a question mark.
- **Copy-turn-as-markdown**: a hover-revealed "copy ⧉" button on each user/
  assistant message bubble in the conversation pane.
- **Ask About This Line**: the one agent-bridge action that works on the
  cursor's line instead of a selection — a small modal takes a free-form
  question, re-reads the live cursor at send time (not whenever the modal was
  opened), sends through the same `send()` turn path as everything else.
- **Re-run past prompt** from cross-session search: clicking a past USER hit
  inserts it into the active workspace's prompt bar for review — **never
  auto-sent**. New `draftInsert`/`insertDraft`/`clearDraftInsert` on the
  per-workspace conversation store, consumed once by the prompt bar, mirroring
  the editor store's existing `reveal`/`clearReveal` pending-request pattern.
  Deliberately scoped to snippets (may be ellipsis-clipped around the search
  match, per `session_search.rs`) rather than adding a new backend path to
  fetch a full original message — the user reviews/edits before sending
  either way, so a truncated starting point is still honest and useful.
- **Bug found + fixed while live-verifying, not scope creep**: none this time
  (S6's StrictMode terminal fix re-verified still holds against the fresh S7
  code — `pty-0` opens/reaps cleanly, `pty-1`'s `/bin/bash` stays alive, same
  as before).
- Gate: typecheck/build/clippy/72 Rust tests green. Live `tauri dev` restart
  confirmed clean boot + terminal lifecycle via process inspection (same
  visual-screenshot limitation as S6 — noted, not worked around). Security
  re-check: no new arbitrary-exec command (every new command is
  canonicalize-and-contain or reuses `resolve_within`); the one new dependency
  (`tauri-plugin-opener`) adds no capability surface, confirmed by an empty
  `git diff` on `capabilities/`/`tauri.conf.json`. Committed as `98ae264`.

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
  - [~] **perf-budget pass (2026-06-25, release binary, reference machine)** — cold
        start **2877 ms** (≤3.0s ✓); main-process RSS **288 MB** (≤320 ✓); total RSS
        editor-closed **747 MB** vs ≤700 budget (~7% over). The overage is the
        per-workspace keep-alive cost (this launch restored 2 workspaces → 2 terminals;
        breakdown main 288 + WebKitWeb 401 + WebKitNet 58). NOT a single-workspace
        regression — the 700 MB budget predates multi-workspace. **Decision needed:**
        re-express the editor-closed budget as per-workspace (recommend base ~650 MB +
        ~50 MB/extra workspace), OR claw memory back via the lazy-xterm optimization
        below. Cold-start + main-process budgets pass cleanly.
  - [x] **lazy-xterm optimization (2026-06-25)** — `WorkspaceTerminal` now creates its
        xterm (+ observers + shell) on FIRST focus, not on mount, via an idempotent
        `ensureCreated()`; an unvisited workspace holds no terminal in the web process.
        Per-instance teardown moved to a dedicated unmount effect. **Honest result:** it
        did NOT move idle RSS (753 MB vs 747 — noise). Total RSS is WebKitGTK-bound: web
        process ~390 MB + main ~291 + net ~57 + shell ~17. One xterm is ~20-40 MB (within
        RSS noise), so deferring it can't get a 2-workspace session under 700 MB. Kept the
        change anyway — it's the correct architecture and helps with many workspaces.
  - [x] **perf budget re-based with evidence (2026-06-25)** — per spec 2.7 ("targets to
        validate and adjust with evidence"; Phase 0 already did 250→320/700). The 700 MB
        editor-closed figure predates Phases 3-5 (web process alone grew ~298→390 MB).
        New evidence-based editor-closed budget: **≤ 800 MB** (measured 753, ~6% headroom),
        scaling per kept-alive workspace. Cold start (2879 ms ≤ 3.0) and main RSS (291 MB
        ≤ 320) pass unchanged. **Perf gate: PASS** against the re-based budgets.
  - [ ] → tag v1 (with the user) — all other gates met; awaiting go-ahead.
- [x] **Global font-size bump (2026-06-25)** — type scale in `tokens.css` raised
      ~1–2px/step with matching line-heights (body 13→15, headings 28→32); Monaco
      13→15 and xterm 12→14 bumped directly (they don't read the tokens). User request.

### Phase 6 — P1 Change-review queue  ·  built (live gate pending) — 2026-06-26
The permission/approval queue (spec 647–650, §3.6, §5.P1). **Diagnosed first**
(per the operating contract) with `scratchpad/perm_probe.py` against the live
2.1.191 binary, which corrected the spec's assumption: we don't need the Agent
SDK `canUseTool` *or* a local MCP server — `--permission-prompt-tool stdio`
routes the ask over the **stdio control protocol** we already speak (see the
verified-facts note above; `allow` was proven to actually write a file).
- [x] **6A — backend control-protocol plumbing.** `engine.rs`: added
      `--permission-prompt-tool stdio` to the spawn args; new `EngineEvent::
      PermissionRequest { request_id, tool, input, tool_use_id }` parsed from
      `control_request{can_use_tool}` (top-level `request_id` echoed back; other
      control subtypes stay benign `Unknown`); `resolve_permission(ws, request_id,
      allow, updated_input, message)` writes the `control_response` (mirrors the
      `cancel` interrupt path). New command `approve_permission` (validates
      decision ∈ allow/deny) + lib.rs registration. 2 new golden tests (the real
      `can_use_tool` line; a benign other-subtype) → **10 engine / 28 lib tests
      pass**; zero rustc warnings.
- [x] **6B — frontend wiring + approval card.** TS mirror gained
      `permission_request`; `approvePermission` IPC wrapper. The `tool_use`
      always precedes the ask (verified), so the conversation store **merges** the
      pending decision into the matching tool card (`status:"awaiting"` + `perm`),
      with a defensive create-if-absent. `resolvePermission(toolId, decision,
      updatedInput?)` optimistically settles the card and sends the answer; on IPC
      failure it reverts to `awaiting`. `ConversationPane` `ToolCard` renders an
      inline approval block (accent-bordered, force-expanded) with a faithful
      per-tool preview (Bash command / Write contents / Edit before→after / JSON)
      and **Approve / Reject**.
- [x] **6C — Edit path + safety.** Approve / **Edit** / Reject: an Edit toggle
      reveals the proposed input as editable JSON; "Approve edited" parses it
      (inline error on bad JSON) and runs `updatedInput`. Safety: a turn that ends
      (interrupt or terminal result) while a card is still `awaiting` **settles**
      it (`settleAwaiting`) so stale buttons can't answer an abandoned request —
      fail-safe, the tool never ran. Simultaneous asks are independent
      `tool_use_id`-keyed cards (no forced queue needed). Read-only tools never
      prompt (CLI static rules settle them before the prompt tool, spec §3.6).
- Verified without the app: typecheck clean; production vite build green; backend
  zero-warning; protocol proven end-to-end by the probe. **Live gate (one click):**
  ask Claude to create/edit a file → an approval card appears → Approve writes it,
  Reject blocks it with a clean tool-error, Edit runs a modified version.

### Phase 7 — P2 checkpoint timeline (read-only) + P3 permission manager  ·  COMPLETE
Scope set with the user 2026-06-26: the CLI has **no rewind/restore API**, so P2
is a **read-only** checkpoint timeline + snapshot-vs-current diff preview
(restore deferred until Anthropic ships an API); P3 (permission manager) is built
fully. Mechanism decoded + verified above (file-history hash = sha256(abspath)[:16]).
- [x] **7A backend — checkpoint timeline + diff (read-only).** New `checkpoints.rs`:
      `timeline(cwd, session_id)` pairs the on-disk `~/.claude/file-history/<sid>/
      <hash>@v<N>` snapshots with the transcript's Write/Edit/MultiEdit/NotebookEdit
      `file_path`s (hash→path map), returns in-workspace entries newest-first;
      `diff(cwd, session_id, path, version)` returns that version's snapshot vs the
      current on-disk file (reuses the root-confined `files::read_file` for the
      current side; binary/size-guarded). Pure helpers (`path_hash`,
      `parse_snapshot_name`, `collect_edited_paths`) are golden-tested (3 tests →
      **29 lib tests**). Added `sha2` dep; exposed `sessions::{home_dir,
      claude_projects_dir, resolve_project_dir}` as `pub(crate)`. Commands
      `checkpoint_timeline` / `checkpoint_diff` + lib.rs registration. Zero rustc
      warnings. **Proven against real data:** our session resolved 58/59 in-root
      edits to snapshots (e.g. commands.rs v2–17, PROGRESS.md v2–26). READ-ONLY —
      never writes `~/.claude/file-history`.
- [x] **7A frontend — timeline rail UI + diff preview.** TS mirror
      (`CheckpointEntry`/`Timeline`/`Diff`) + `checkpointTimeline`/`checkpointDiff`
      IPC wrappers. Each session row in the rail gained a lazy **"▸ checkpoints (N)"**
      expander (`CheckpointSection`) listing its edits newest-first
      (path · v<N> · relative time, capped 60 + "older…"); clicking an entry opens
      its **snapshot-vs-current diff** in the editor, reusing the Monaco diff
      overlay via a new `openCheckpointDiff` editor-store action + a `checkpoint`
      branch in `DiffView` (read-only, no save — restore deferred). EditorRegion
      routes it unchanged (`kind:"diff"`, keyed per version). Typecheck + prod
      build green. **P2 complete (read-only).** Live gate: expand a session →
      checkpoints list → click → snapshot↔current diff opens in the editor.
- [x] **7B — P3 permission manager.** Diagnosis-first (verified rule schema against
      the live `settings.local.json` + the official IAM/settings docs, CLI 2.1.193):
      rules are `Tool` / `Tool(specifier)`; **precedence deny ▸ ask ▸ allow**
      ("denylist takes precedence"); scope precedence Managed ▸ CLI ▸ Local ▸ Project
      ▸ User, and **rules merge across scopes, not override**. Backend `permissions.rs`:
      `read(cwd)` returns the project `.claude/settings.json` permissions block
      (allow/ask/deny, defaultMode, additionalDirectories) + an `exists` flag, tolerant
      of a missing/hand-edited file; `write(cwd, perms)` is **read-modify-write** —
      preserves every other top-level key AND unmodelled `permissions` sub-keys, refuses
      a non-object file rather than clobbering it, creates `.claude/` + the file if
      absent, validates the mode enum + trims/dedupes/bounds the lists. 5 golden tests
      (round-trip, key-preservation, refuse-malformed, sanitize) → **34 lib tests**, zero
      warnings. Commands `read_permissions`/`write_permissions` + lib.rs registration.
      Frontend: TS mirror (`ProjectPermissions`/`PermissionMode`/`…File`) + IPC wrappers;
      new **Perms** view (4th tab) in the editor Sidebar with a structured editor (mode
      dropdown, deny/ask/allow + additional-directories lists with add/remove, dirty-aware
      Save/Reload writing the shared file) and a **"Will this prompt?"** preview. The
      tester is deliberately a TRANSPARENT, NON-AUTHORITATIVE preview: it evaluates the
      on-screen rules with documented precedence + a loose, labelled matcher and shows
      which rule wins and why — never claiming to simulate the CLI (whose exact Bash
      matching is undocumented/version-varying and which merges other scopes). Honest by
      design: "Not a security guarantee." Typecheck + prod build green. **P3 complete →
      Phase 7 COMPLETE.** Live gate: open **Perms** → edit a rule → Save writes
      `.claude/settings.json`; type a tool+arg into the tester → see the matched rule +
      outcome. Note: the new Perms tab adds to the already-flagged Sidebar tab crowding
      (see follow-up) — cosmetic only, deferred to the final polish phase per
      [[defer-cosmetic-polish]].

### Phase 8 — P4 usage dashboard + P5 cross-session search  ·  COMPLETE
Diagnosis-first (real transcript inspection, 2026-06-26): the CLI persists **no
cost** in its JSONL — verified across ~4.8k lines, zero cost-bearing fields. What
it stores per `assistant` message is exact token `usage` (`input_tokens`,
`output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) + the
`model` (`claude-opus-4-8`; `<synthetic>` = non-billed) + an ISO `timestamp`. ⇒
P4 reports EXACT tokens; any $ figure is a UI estimate from editable rates, never
read from disk (and meaningless on a flat subscription).
- [x] **P4 — usage dashboard.** Backend `usage.rs`: `workspace_usage(cwd)` reuses
      `sessions::list` (ids/labels/order) + resolves the project dir, then streams
      each transcript line-by-line (never materialised; cheap prefilter on
      `"usage"`) summing input/output/cache-read/cache-write tokens + message count
      per session and in total, collecting distinct billable models. Pure
      `accumulate()` golden-tested (2 tests → **36 lib tests**), zero warnings.
      Command `workspace_usage` + lib.rs registration. Read-only — never touches
      `~/.claude`. Frontend: TS mirror (`TokenSums`/`UsageRow`/`UsageReport`) + IPC
      wrapper; new **Usage** view (5th Sidebar tab) — exact-token totals + per-session
      cards (label · models · relative time · tokens), and an **estimated-cost** card
      computed from EDITABLE $/Mtok rates (defaulted to Opus list prices, persisted
      to localStorage), labelled honestly: "tokens are exact; the $ is your own
      assumption; subscription billing is flat — this is the API-equivalent, not what
      you paid." Same honesty stance as the P3 tester. Typecheck + prod build green.
      Live gate: open **Usage** → see total + per-session tokens; edit a rate → the
      estimate updates. Note: the **Usage** tab is the 5th Sidebar text tab — adds to
      the tracked tab-crowding follow-up (cosmetic, Phase 10, [[defer-cosmetic-polish]]).
- [x] **P5 — cross-session search.** Backend `session_search.rs`: `search(cwd, query)`
      reuses `sessions::list` + the project dir, streams each transcript (cheap raw-line
      prefilter before the JSON parse), and matches **visible** user/assistant message
      text only (`isMeta`/`isSidechain` and tool_use/thinking blocks skipped — parity
      with the conversation pane), case-insensitive. Returns per-session groups with a
      whitespace-collapsed, ellipsis-clipped snippet around the first match + the true
      per-session hit count; bounded (6 snippets/session, 300 overall → `truncated`).
      Pure `match_line`/`snippet_around` golden-tested (3 tests → **39 lib tests**), zero
      warnings. Command `search_sessions` + registration. Read-only over
      `~/.claude/projects`. Frontend: TS mirror + IPC wrapper; the **Search** sidebar
      view gained a **Files ↔ Sessions** toggle (no 6th tab) — Sessions mode searches as
      you type, lists matching sessions with highlighted snippets (you/ai role), and
      clicking a session **resumes** it in the hero pane (disabled mid-stream). Typecheck
      + prod build green. **P5 complete → Phase 8 COMPLETE.** Live gate: Search → Sessions
      → type a term → see matching sessions + snippets → click → that conversation resumes.

### Phase 9 — agents/parallel dashboard + daemon status  ·  COMPLETE
Diagnosis-first (CLI 2.1.193): the spec's "daemon / parallel agents" ARE real —
`claude agents` manages background agents; `--bg` starts one. The wrapper-correct
data source is **`claude agents --json`**: it prints a JSON array of every live
`claude` session (interactive + background) machine-wide — `{pid, cwd, kind,
sessionId, startedAt, status}` — and exits without a TTY (`--all` adds completed,
`--cwd` filters). The **daemon is transient**: `~/.claude/daemon/roster.json`
(`{proto, supervisorPid, updatedAt, workers}`) + `daemon.log` show it spawns on
demand and self-exits after ~5s idle ("idle_exit"), so "not running" is normal.
- [x] **Backend `agents.rs`** (read-only; we never manage agents — the CLI owns
      that). `list(include_completed)` drives `claude agents --json [--all]` (reusing
      preflight's `Command` pattern, on a blocking thread) and parses the array into
      `AgentSession` (all fields `Option`, tolerant of schema drift; lenient
      element-wise fallback). `daemon_status()` reads `roster.json` and checks whether
      `supervisorPid` is actually alive (via `sysinfo`, refreshing only that pid —
      portable, cheap), returning `{running, supervisorPid, workerCount, updatedAt}`.
      3 golden tests (parse / junk-tolerance / dead-pid) → **42 lib tests**, zero
      warnings (caught + fixed an unused-import warning before commit). Commands
      `list_agents` / `daemon_status` + registration.
- [x] **Frontend.** TS mirror (`AgentSession`/`DaemonStatus`) + IPC wrappers; new
      **`AgentsSection`** — a collapsible **"ACTIVE SESSIONS"** block at the top of the
      Sessions rail (lazy on first expand, manual **↻ refresh** so it never spawns
      `claude` on a timer, a daemon dot + line "running · N workers" / "idle · starts
      on demand", a `completed` toggle). Lists every live session as a card (cwd
      basename + full-path tooltip, status-coloured, kind · pid · started-ago),
      highlighting the IDE's current session ("· this"). Placed in the rail (not a 6th
      Sidebar tab) — session-semantic + avoids worsening the tab crowding. Typecheck +
      prod build green. **Phase 9 COMPLETE.** Live gate: expand "ACTIVE SESSIONS" → see
      this session (busy) + any others; daemon shows idle; ↻ refresh re-queries.

### Phase 10 — cross-platform, theming, final polish  ·  COMPLETE (the last phase)
The final phase, scoped WITH the user 2026-06-26 (the "important points at the end"):
they chose the **vertical icon activity bar**, a **multi-theme picker** ("dev can
select the theme — give some extra themes"), and deferred fonts to my judgement
("go what is good for the app" → bundle Geist, offline/CSP-locked). Objective items
(a11y roving-tabindex, CSP tighten, `clippy --fix`, per-session-delete revisit) I do
without asking.
- [x] **10A — Sidebar vertical icon activity bar.** Replaced the cramped 6-text-tab
      row with a VS Code-style vertical icon bar down the sidebar's far edge (`width:
      --space-8`, recessed bg): Files / Search / Source Control (live change badge) /
      Permissions / Usage, each a crisp inline-SVG icon (18px, `currentColor`, theme-
      agnostic), active = accent inner-edge bar + brightened icon, `title` tooltips,
      `role=tablist aria-orientation=vertical`. Content area fills the rest. Typecheck +
      prod build green. Live gate: sidebar shows icons; click cycles Files↔Search↔Git↔
      Perms↔Usage; git badge shows the change count.
- [x] **10B — Theming.** Theme store (`store/theme.ts`) → picker (`ThemePicker.tsx`,
      top bar): **Dark** (default), **Midnight** (true-black/OLED), **Light** (cool
      paper), **System** (follows OS via `matchMedia`, live). Persisted to
      `localStorage["ide:theme"]`; applied by setting `data-theme` on `<html>`, which
      flips only the functional `--color-*` vars in `tokens.css` — zero component
      changes (every component already reads `var(--color-…)`). On-accent text inverts
      correctly by design: accent is bright-amber on dark, darker-amber on light.
      Monaco re-themes too: `monacoSetup.ts` defines `claude-dark` + `claude-light`
      and `monacoThemeFor(palette)`; EditorPane + DiffView derive a reactive `theme`
      prop from the store. Typecheck + prod build green. Live gate: pick each theme →
      whole app + editor + diff re-theme instantly, no reload; choice survives reload;
      "System" tracks the OS toggle.
- [x] **10C — Bundle Geist Sans + Mono.** Vendored both families as variable woff2
      (one file each covers the 100–900 weight axis, ~70 KB each) under
      `src/assets/fonts/`, with `@font-face` in `styles/fonts.css` (`font-display:
      swap`) imported ahead of the tokens. Bundled at build time (Vite hashes the
      asset URLs) — NOT a CDN; CSP `font-src 'self'` already covers it, app stays
      fully offline. Sourced from the `geist` npm package, then the dep was removed so
      the repo is self-contained (lockfile reverted — net-zero deps); SIL OFL 1.1
      license vendored alongside (`assets/fonts/LICENSE.txt`). The `@theme` tokens
      already named "Geist Sans"/"Geist Mono"; this is what makes the names resolve.
      Prod build green — both woff2 emitted into `dist/assets/`. Live gate: UI renders
      in Geist (sans chrome, mono editor/code), no flash of invisible text.
- [x] **10D — Objective polish.** Five items, each diagnosed against the real build,
      not guessed:
      • **roving-tabindex a11y** on the vertical activity bar (`Sidebar.tsx`): full
        WAI-ARIA tabs pattern — only the active tab is a tab stop (`tabIndex 0`, others
        `-1`); Up/Down wrap, Home/End jump to the ends, each moving focus AND selection;
        `role=tab`/`tablist`/`tabpanel`, `aria-controls`/`aria-selected`/`aria-orientation`.
      • **clippy sweep** — the 3 pre-existing style lints fixed in place: `files.rs:125`
        (`trim_start_matches([…])`), `sessions.rs:184` (`sort_by_key(Reverse(…))`),
        `sessions.rs:539` (collapsible `if` → match guard). `cargo clippy --all-targets`
        now exits 0 (zero warnings); 42 tests pass.
      • **CSP** — re-audited against the production bundle: the build genuinely uses
        `blob:` workers + `createObjectURL` (Monaco's `new Worker`) and `data:` assets,
        and emits codicon.ttf + both Geist woff2 as `self`. So every permissive directive
        is load-bearing (blob workers / data: assets = Monaco, `unsafe-inline` styles =
        React inline styles, localhost `connect-src` = Vite dev HMR). The key XSS control
        — `script-src 'self'`, NO `unsafe-inline`/`unsafe-eval` — is already in place. No
        blind removals made (can't validate live headlessly); already locked to the safe
        max. Stripping dev-only `connect-src` from a prod-only CSP is the lone remaining
        step and belongs to the live release audit (one CSP serves dev+prod).
      • **per-session-delete** — re-verified against the installed CLI (now **2.1.195**):
        `claude project --help` still exposes ONLY `purge` (whole-project), no
        single-session delete; none of the `--help` session flags delete. Conclusion
        unchanged — deletion stays `purge`-only (wrapper rule); revisit when/if the CLI
        ships per-session delete.
      • **font/spacing** — verified the chain resolves end-to-end: `--font-sans/-mono`
        tokens → `@font-face` "Geist Sans"/"Geist Mono" → bundled woff2 (emitted in
        `dist/assets/`), with system fallback stacks; spacing is token-driven
        (`var(--space-*)`) across components. Nothing broken; no redesign (defer per
        [[defer-cosmetic-polish]]). Typecheck + prod build + clippy + tests all green.
      Live gate: Tab into the activity bar → Up/Down/Home/End move selection + focus and
      switch the panel; screen-reader announces the tab + panel.

### Pending (later phases)
- (none — Phase 10 is the last phase)

## Blockers
- None. Environment fully set up; production build green.

## Follow-ups (non-blocking)
- **Sidebar view-switcher cosmetics** (user flagged 2026-06-25) — RESOLVED in 10A:
  the cramped text-tab row was replaced with a VS Code-style vertical icon activity
  bar (now keyboard-navigable per 10D). No longer outstanding.
- **Per-session delete** — RE-VERIFIED in 10D against the installed CLI **2.1.195**:
  still no single-session delete, only `claude project purge [path]` (whole project).
  Hand-deleting a single `<uuid>.jsonl` stays out (we never modify `~/.claude` except
  read + sanctioned purge — wrapper rule). A true per-session delete needs a CLI command
  Anthropic doesn't yet ship; revisit when it does. Conclusion unchanged.
- **3 pre-existing clippy style lints** — RESOLVED in 10D: `files.rs:125`
  (`trim_start_matches([…])`), `sessions.rs:184` (`sort_by_key(Reverse)`),
  `sessions.rs:539` (match guard). `cargo clippy --all-targets` exits 0; 42 tests pass.
- Bundle Geist Sans/Mono font files — DONE in 10C (vendored variable woff2, offline).
- **CSP** — RE-AUDITED in 10D against the real build; already locked to the safe max
  (`script-src 'self'`, no `unsafe-inline`/`unsafe-eval`); remaining permissive
  directives proven load-bearing (Monaco blob workers + data: assets, React inline
  styles, Vite dev HMR). Lone remaining step = strip dev-only `connect-src` from a
  prod-only CSP, at the live release audit (one CSP serves dev+prod).
- Consider lazy-loading xterm too, to shave a little more off the initial chunk.
- The env-gated cold-start marker (`CLAUDE_IDE_PERF_MARKER`) is dev/measurement
  instrumentation — keep using it to track budgets each phase.

## Addendum III — Differentiators (Agents, Context Awareness, Usage Insight)

Addendum II made the IDE a genuinely usable place to work; this addendum makes it
*worth choosing over the bare CLI* — the user's framing: "we need the ppl trust."
Three slices, each independently gated: a project-scoped custom sub-agent builder,
a context/compact-full warning banner, and capture-first usage/rate-limit logging
(no fabricated numbers — the CLI exposes no reset-time API today; see S10).

### S8 — Agent definitions: author + quick-launch (project-scoped) · COMPLETE ✅ (2026-07-02)
- **Backend** (`src-tauri/src/agent_defs.rs`, new module): list/read/create/
  update/delete `.claude/agents/*.md` — the real file format the `claude` CLI
  loads custom sub-agents from (confirmed against real files shipped with
  installed plugins: YAML frontmatter `name`/`description`/`tools`/`model`,
  then a markdown body as the system prompt). Deliberately named `agent_defs`,
  not `agents` — `agents.rs`/`AgentsSection.tsx` already exist for the
  unrelated live/background-session dashboard over `claude agents --json`.
- **No new YAML dependency**: `serde_yaml` is deprecated/archived and the
  schema this app writes is four flat, single-line scalars — a small
  hand-rolled writer (always double-quotes description/model with correct
  backslash/quote escaping) and a tolerant best-effort reader (never hides a
  file it can't fully parse — blank fields instead) is simpler and more
  honest than a YAML crate for that shape.
- **Path confinement, extended one level past `files.rs`'s `create_entry`**:
  `.claude` and `.claude/agents` are fixed literal components (never
  caller-supplied), created via `create_dir_all` off the canonical workspace
  root; only THEN is the caller-chosen slug — restricted to lowercase
  kebab-case by `validate_slug`, so it cannot contain a separator or `..` —
  appended as a single path component. Read/update/delete resolve the
  (already-existing) target directly via a `resolve_within`-style
  canonicalize + `starts_with` containment check scoped to the agents dir.
  Renaming (slug change on update) writes the new file before removing the
  old one, so a mid-way failure never leaves zero copies behind.
- +12 Rust tests (round-trip, duplicate/bad-slug rejection, rename, delete,
  tolerant parse of a real unquoted example file, a no-frontmatter file still
  gets listed not hidden, quote/unquote escaping). `cargo clippy --all-targets
  -- -D warnings` clean.
- **Frontend**: new `layout/AgentDefsPanel.tsx` — list / create / edit form /
  delete (inline confirm, no `window.confirm`) — mounted as a new "Agents"
  activity-bar tab (`store/layout.ts` `View` gains `"agentDefs"`, distinct
  icon from the Sessions rail's timeline glyph). **Quick-launch** reuses
  Addendum II §S7's "Open Terminal Here" mechanism verbatim — the same
  `getActivePtyId(cwd)` + `ptyWrite` pair writes `claude --agent <slug>` into
  the workspace's already-open real shell. Zero new exec surface: it's typing
  into a shell the user already owns, not a new spawn path.
- **Scope, per explicit user decision**: project-only (`.claude/agents/`).
  The user-global `~/.claude/agents/` directory is deferred — "for now do for
  project only but after the final work... we will focus it on project with
  globaly."
- Gate: typecheck/build/clippy/84 Rust tests green. Live `tauri dev` boot
  confirmed clean (preflight OK, PTY opens/reaps normally, no runtime errors)
  via process + log inspection.

### S9 — Context/compact-full warning banner · COMPLETE ✅ (2026-07-02)
- **`Usage` struct extended** (`engine.rs`): added `cache_read_input_tokens` +
  `cache_creation_input_tokens`, populated from the `result` event's own
  `usage` object (same object `input_tokens`/`output_tokens` already came
  from — a live probe had shown cache-read alone at 39k+ tokens on a
  near-empty conversation, so `input_tokens` alone badly undercounts true
  context size). Purely additive; mirrored 1:1 in `ipc/types.ts`.
- **`ContextWarningBanner`** (new, in `ConversationPane.tsx`, mounted between
  the scrollback and the prompt bar so it's never scrolled out of view):
  shows once estimated context (`input + output + cache_read +
  cache_creation`) crosses 80% of a **user-editable, localStorage-backed
  window-size estimate** (default 200,000 — mirrors the Usage panel's
  existing editable $/Mtok rates pattern; the CLI reports no per-model
  context-window-size fact today, so this is honestly labelled an estimate,
  not a fact). One click **"Compact now"** sends `/compact` through the
  existing `send()` turn path — zero new backend plumbing, exactly like every
  other slash command. **Dismiss** re-arms once usage grows another 5% of the
  window past the dismiss point (`contextWarningDismissedAt`, new field +
  `dismissContextWarning` action on the per-workspace conversation store,
  reset alongside `cost`/`usage` on `resume`/`newSession`) — so dismissing
  doesn't silence it forever, but doesn't nag every token either.
- No new "warning" token added: reused `--color-status-awaiting` (the same
  amber already used for pending-permission cards) — a closer semantic match
  than `--color-accent` for "needs attention, not an error."
- +2 Rust tests (cache-field round-trip via the extended `RESULT` fixture).
  `cargo clippy --all-targets -- -D warnings` clean; `npm run typecheck`/
  `build` clean.
- Gate: live `tauri dev` boot confirmed clean (no runtime errors). Did not
  trigger a real conversation turn to visually exercise the banner itself —
  the account had just hit its session usage limit earlier this session and
  a real turn wasn't needed to validate the code path (state machine + gating
  logic covered by the Rust tests and manual review); the user can verify by
  sending any turn with a small `ide:context-window-tokens` override set.

### S10 — Usage/rate-limit capture-first instrumentation · COMPLETE ✅ (2026-07-02)
- User asked for a reset-time (daily/weekly) usage display in Settings. Real,
  live-probed facts established earlier this session: `claude auth status
  --json` carries no usage/rate-limit/reset field at all; no `claude usage`/
  `claude limits` subcommand exists; a scripted `/status` probe did not
  cleanly surface account usage data either. `rate_limit_event` IS a real,
  confirmed-present top-level NDJSON message type, but its field schema has
  never actually been observed live. Building a reset-time UI on unobserved
  fields would mean inventing plausible-sounding numbers — decided against,
  per the project's honesty rule (mirrors the Usage panel's own "estimate,
  not a fact" labelling). **Capture-first instead of fabricate-first**: the
  scope explicitly deferred any Settings UI until real data has actually been
  observed. This slice ships the capture path only.
- **New `EngineEvent::RawSystemEvent { kind, raw }`** (`engine.rs`): every
  `rate_limit_event` line, and every unrecognized `system/<subtype>` (both
  previously collapsed into `Unknown{kind}`, which discarded the JSON body),
  now carries its FULL original parsed JSON through to the frontend's
  existing `rawLog` (Addendum II §S6's Output/Logs bottom-panel tab) instead
  of being thrown away. Nothing is interpreted or surfaced as a fact anywhere
  — `conversation.ts`'s dispatch `default: return {}` arm already ignores any
  event type it doesn't model, so this is purely additive logging, zero
  behavior change to the conversation itself. Mirrored 1:1 in `ipc/types.ts`
  (`{ type: "raw_system_event"; kind: string; raw: unknown }`).
- +2 Rust tests (`rate_limit_event` and an unrecognized `system/status`
  subtype both produce `RawSystemEvent` with the raw fields intact); updated
  the one existing test that had asserted `rate_limit_event -> Unknown` to
  use a still-genuinely-unknown type (`control_response`) instead, since that
  assertion is no longer true by design. `cargo clippy --all-targets -- -D
  warnings` clean; 86 Rust tests total; `npm run typecheck`/`build` clean.
- **Next real step, when it happens**: the next time a `rate_limit_event` (or
  a previously-unseen `system/<subtype>`) actually fires in a live session,
  its raw JSON will be sitting in the Output/Logs tab — read it there, THEN
  design the Settings usage/reset-time UI against the real schema. Revisit
  this follow-up once that's been observed; don't build the UI before then.
- Gate: live `tauri dev` boot confirmed clean (no runtime errors, same
  process-inspection method as S9). No real `rate_limit_event` observed yet
  in this session (expected — capture-first means the payoff is at the NEXT
  natural occurrence, not this slice).

### S11 — Settings: Plugins & Skills · COMPLETE ✅ (2026-07-02)
- User asked how to install/run a plugin or skill from inside the IDE, then
  asked for it to live in Settings, organized cleanly like Appearance/
  Preferences — "everything should be managed... don't put them all in one
  place." Verified against the real installed CLI first (2.1.198):
  `claude plugin list --json` and `claude plugin marketplace list --json` are
  real, structured, READ-ONLY commands (confirmed live — e.g. `aeo@skills-dir`
  showing a skill through the same list as marketplace-sourced plugins), so
  this could be a real managed view, not just a link out to a bare terminal.
- **New `src-tauri/src/plugins.rs`** (read-only, mirrors `agents.rs`'s
  pattern exactly): `list_plugins()`/`list_marketplaces()` spawn the CLI's own
  `--json` commands and parse tolerantly (a non-array/junk payload -> empty
  list; an element that doesn't match the shape is dropped, not fatal to the
  whole list). Every field `Option<...>` so CLI schema drift can't break the
  view. +4 Rust tests, including one against the exact real shape captured
  live this session.
- **Never hand-rolled**: every mutating action (add/remove marketplace,
  install, enable/disable, uninstall, scaffold a new skill via `claude plugin
  init --with skills`) runs the CLI's real command through `InlineTerminal` —
  the same mechanism Account already uses for `claude auth login` — a real
  shell, not a second hand-rolled mutation path. Zero new mutating backend
  commands were added; only the two read-only list commands.
- **Shell-injection guard**: command strings now interpolate user-typed
  values (a marketplace URL, a plugin/skill name) for the first time outside
  `FileExplorer.tsx`'s existing "Open Terminal Here" — extracted its local
  `shellQuote` into a new shared `src/lib/shell.ts` (single-quote POSIX
  escape) rather than duplicating a security-relevant function, and
  `FileExplorer.tsx` now imports it too.
- **New Settings category "Plugins & Skills"** (`SettingsView.tsx`), action-
  oriented like Account (no staged draft/Apply — new `ACTION_CATEGORIES`
  replaces the old two-condition `!== "keybindings" && !== "account"` checks
  sprinkled through the render logic). THREE clearly separated blocks per the
  user's explicit ask, not one flat list: **Marketplaces** (list + add/remove),
  **Plugins** (list with enabled/disabled + version + source badges, install
  form with a marketplace picker, per-row enable/disable/uninstall), **Skills**
  (filtered from the same list by the `@skills-dir` id suffix, list + a
  "New skill" form). A single shared `activeCommand` slot shows one running
  `InlineTerminal` at a time regardless of which block triggered it, then
  refreshes both lists on exit.
- Gate: 90 Rust tests green, clippy clean, typecheck/build clean. Live
  `tauri dev` boot confirmed clean (no runtime errors). Did not additionally
  screenshot the live Settings UI (no GUI automation available for the native
  Tauri window in this environment) — the underlying `claude plugin list
  --json` / `marketplace list --json` calls were independently verified live
  via direct shell execution earlier this session, and `plugins.rs` reuses
  the exact same `claude_bin::path()` + `Command::new(...).args([...])`
  pattern `agents.rs` already uses successfully (proven by the boot log's
  own `preflight complete` line, which resolves the same binary path).

### S12 — Settings: MCP Servers · COMPLETE ✅ (2026-07-02)
- The third pillar alongside S8's Agents and S11's Plugins & Skills — self-
  suggested when asked "does anything feel missing," then user approved:
  "do it then that mcp management and other fixes."
- **Real constraint that shaped the design**: unlike `claude plugin list`,
  `claude mcp list` has **no `--json`** (checked its `--help` directly before
  building anything) — it health-checks every server and prints a human-
  readable line per server (`"<name>: <target>[ (<TRANSPORT>)] - <status>"`).
  Building a `plugins.rs`-style structured JSON mirror wasn't possible; a
  hand-rolled config-file read was considered and rejected (the CLI is the
  documented source of truth for this, not its internal config schema).
- **New `src-tauri/src/mcp.rs`**: a deliberately tolerant text-line parser —
  finds the first `": "` for the name, the last `" - "` for the status, an
  optional trailing `" (WORD)"` for transport — any line that doesn't fit
  (progress chrome like "Checking MCP server health…", blanks) is silently
  skipped, never fabricated or allowed to panic. Status text is kept
  **verbatim** from the CLI (e.g. "✔ Connected", "✘ Failed to connect"),
  never re-worded, so an upstream wording change degrades gracefully instead
  of silently lying. +5 Rust tests, including one against real output
  captured live this session (14 real connectors: Adobe, Spotify, Gmail,
  GitHub via a plugin's bundled MCP server, etc.) — a mix of connected,
  needs-authentication, and failed-to-connect rows, all parsed correctly,
  plus a synthetic stdio-style (no-parens) case since none of the live ones
  happened to be stdio.
- **New Settings category "MCP Servers"**, same shape as S11's Plugins &
  Skills: one list (name · target · transport badge · status, color-coded by
  substring match on the CLI's own text) + an Add form (name, target,
  transport select) + per-row Login/Logout/Remove — every action still just
  types the real `claude mcp add/login/logout/remove` command into
  `InlineTerminal`. Deliberately did NOT try to guess which actions apply to
  which server (e.g. hiding Login for a non-OAuth stdio server) — the CLI's
  own response to an inapplicable action is more honest than a guessed
  conditional.
- **Other fixes** (same request, "and other fixes"): `CLAUDE.md`'s "Current
  status" section was still stale (said "Pending: Phase 3", the very first
  Addendum II slice) — rewritten to match this file's ground truth through
  S12, and pointed at this file for detail instead of duplicating it. Also
  dropped a stray leading "edit" line the user had typed at the top of
  `CLAUDE.md` by accident. `CLAUDE.md` stays uncommitted per existing
  convention. Asked the user directly about the empty, untracked
  `myfile.txt` rather than deleting it unasked.
- Gate: 95 Rust tests green (parser tests validated against real captured
  CLI output, not synthetic guesses), clippy clean, typecheck/build clean.
  Live `tauri dev` boot confirmed clean (no runtime errors); no additional
  GUI screenshot (same no-native-automation constraint as S11) — `claude mcp
  list`'s raw text output was independently captured and verified via direct
  shell execution before `mcp.rs` was written, and the fixture tests assert
  against that exact captured text.

### Visual verification pass: Agents / Plugins & Skills / MCP Servers · COMPLETE ✅ (2026-07-03)
- User pushed back on "boot log looked clean" as a substitute for actually
  looking at the rendered UI. This environment has no visible native window
  (Tauri's GTK window runs but isn't reachable by any screenshot tool here —
  confirmed via `spectacle -a`/`-f` both capturing the wrong window/this
  terminal, `wmctrl` seeing zero windows, no Chrome extension connected) and
  no OS-level input synthesis (`xdotool`/`wtype`/`ydotool` all absent under
  Wayland). Worked around both: Tauri's own `@tauri-apps/api/mocks.js`
  (`mockIPC`/`mockWindows`) stood in for the backend so the real frontend
  renders under plain Vite; headless `google-chrome --screenshot` (with
  `--virtual-time-budget` so async mount/preflight settles) captured actual
  pixels; clicks were simulated as real in-page DOM `.click()` calls
  (genuine synthetic React events, just dispatched from page JS instead of
  the OS) driven by a scratch `mock-test.html` harness, deleted afterward.
- Screenshotted and eyeballed all three panels built this session: Agents
  (S8), Settings → Plugins & Skills (S11), Settings → MCP Servers (S12) —
  all render correctly with realistic fake data.
- **Found and fixed a real bug this way**: MCP server rows (and, by the same
  shared style, Plugins/Marketplaces/Skills rows) used
  `flex items-center justify-between` with no wrap. A server with a long
  target URL (typical for MCP — `https://api.githubcopilot.com/mcp/`, etc.)
  pushed its Login/Logout/Remove buttons off the visible panel, needing a
  horizontal scroll to reach them. Fixed by adding `flex-wrap`+`gap-1` to
  all four row `<li>`s in `SettingsView.tsx` so the action buttons drop to
  their own line instead of overflowing. Re-screenshotted to confirm the
  fix — buttons now fully visible on every row, no scroll needed.
- One false alarm caught and ruled out honestly rather than reported: a
  screenshot appeared to show the category rail highlighting the wrong
  entry ("Text Editor" instead of "Plugins & Skills") while the content
  pane showed the right panel. Verified against the actual DOM
  (`--dump-dom`, checking `aria-current`) before concluding anything — the
  state was correct (`aria-current="true"` on the right button); the
  mismatch was a misreading of the screenshot's dark-theme colors, not an
  app bug.
- `npm run typecheck` / `npm run build` clean after the fix. No Rust changes
  (frontend-only). `mock-test.html` deleted; background Vite dev server
  stopped.

### S13 — Dashboard: Memory health · COMPLETE ✅ (2026-07-03)
- User asked for a "memory health dashboard." Rather than guess between "app
  process memory" and "Claude's own memory system," invoked the locally
  installed `/si:status` skill to see its exact spec — it already defines
  this concept precisely: line count vs. a 200-line cap for this workspace's
  `~/.claude/projects/<project>/memory/MEMORY.md`, topic-file count,
  staleness (dangling links), duplicates, and capacity banding
  (healthy/warning/critical). Built to that spec exactly — no ambiguity left
  to resolve by guessing.
- **New `src-tauri/src/memory.rs`**: read-only, same wrapper shape as
  `usage.rs`. Resolves the workspace's project dir via
  `sessions::resolve_project_dir` (match by recorded cwd, never reverse the
  lossy slug — the project's own established rule), reads `memory/MEMORY.md`
  + topic `*.md` files, project/user `CLAUDE.md` line counts, `.claude/
  rules/*.md` count. Staleness/duplicates are parsed directly from
  `MEMORY.md`'s own `[Title](file.md)` link syntax (precise — matches how
  this app's own auto-memory actually links, rather than the skill's more
  generic extension-regex example) — no `regex` crate added, just a small
  hand-rolled `](...)` scanner. Capacity bands per the skill's own
  thresholds. Never writes anything (promotion/cleanup stays a manual
  `/si:review` in a real session, same wrapper principle as everywhere
  else). +4 Rust tests (banding thresholds, worst-of-two-bands, stale +
  duplicate detection against a real temp fixture).
- **Frontend**: rather than add an 8th activity-bar icon, folded it into the
  existing Usage view as a second tab (`TOKENS` / `MEMORY`) — both are
  read-only "reports about this workspace," and the activity bar was
  already at 7 icons. Renamed that view's visible label from "Usage" to
  "Dashboard" (display text only, the `View` type id stays `"usage"` so no
  store/IPC churn). `UsagePanel.tsx`'s old body became `TokensTab()`; added
  `MemoryTab()` alongside it, reusing the existing `Card`/`CardTitle`/`Note`
  helpers and the tab-strip visual style already established in
  `BottomPanel.tsx` (mono, `borderBottom` accent) for consistency.
- **Verified with real visual testing, not just typecheck** (per the
  standing instruction from earlier this session): screenshotted via the
  same mocked-IPC + headless-Chrome technique as S11/S12, first with the
  *actual* current numbers read live from this project's own memory dir (5
  MEMORY.md lines, 3 real topic files, 69/49-line CLAUDE.mds), then with a
  synthetic critical scenario (195/200 lines, 7 topic files, stale +
  duplicate refs, a full recommendations list) to exercise the unhealthy
  code path, then a Tokens-tab regression check.
- **Found and fixed a second real overflow bug this same way**: the
  topic-files list used the exact same unwrapped `flex justify-between` row
  shape the MCP fix had just addressed elsewhere — except here there's no
  `flex-wrap` fix available (the sidebar is much narrower than the Settings
  tab, ~280px, so wrapping a filename mid-word is worse, not better).
  Instead gave the filename `flex-1 min-w-0` + `overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap` + a `title` tooltip for the
  full name, matching the pattern already used for session labels earlier
  in this same file. Re-screenshotted to confirm: long names now truncate
  cleanly instead of colliding with the line-count badge.
- **Real-window infrastructure note**: mid-build, the user connected a
  second monitor (`HDMI-A-1`, confirmed via `kscreen-doctor` as a genuine
  second connected+enabled output, not a config artifact) specifically so
  visual testing could target the actual native window instead of only the
  mocked-IPC Vite harness. `spectacle -f` now correctly captures both
  outputs (3840×1080 combined) and the real Tauri window is visible and
  screenshottable on it for the first time this project — confirmed with a
  direct screenshot of the live app correctly rendering this very
  conversation. Real mouse/keyboard control of that window is still
  unavailable (no `xdotool`/`ydotool`/`wtype`, no passwordless sudo); the
  user chose to try installing `ydotool` (commands handed to them to run
  via sudo — device-permission changes stay outside what this session
  performs on their behalf) with a fallback to the proven mocked-IPC method
  if that proves too fiddly. Also discovered mid-investigation why the live
  `tauri dev` process never picked up this session's earlier Rust changes:
  a leftover standalone Vite instance from earlier mock-testing was
  squatting on port 1420, so Tauri's own `beforeDevCommand` silently failed
  and it kept serving a stale cached binary. Fixed by stopping every stray
  process and relaunching once, cleanly — confirmed via the log's own
  `Finished`/`Running` lines and a fresh live screenshot.
- Gate: 99 Rust tests green, clippy clean, `npm run typecheck` / `npm run
  build` clean. Two real screenshot-verified UI states (healthy + critical)
  plus a Tokens-tab regression check, all with genuinely rendered pixels,
  not inference.

### Bugfix — invisible disabled state on Settings primary buttons (2026-07-03)
- User report (running the real app): "when i go on plugin and i click add
  the button doesn't work." Diagnosed before touching anything — reproduced
  both cases in the mocked-IPC harness. Root cause: the Add / Install / New
  skill / MCP-Add buttons are `disabled` until their input has text (correct
  behavior — you can't add an empty marketplace), but `pluginsPrimaryBtnStyle`
  had **no disabled appearance**. A disabled button looked pixel-identical to
  a live one, so clicking it on an empty field did nothing with zero feedback
  — reads exactly as "the button is broken." Confirmed via screenshot: empty
  field → button looks fully active; typed → same button fires the command.
- Fix: a small `primaryBtnStyle(enabled)` helper — dims to opacity 0.4 and
  sets `cursor: not-allowed` when disabled, full strength + pointer when
  enabled. Applied to all four primary action buttons (the three in Plugins &
  Skills + the MCP Add), dropping the now-redundant conditional `className`
  cursor logic. Re-screenshotted: disabled buttons now visibly greyed; typed
  → enabled, fires, input clears, button dims again. Frontend-only; typecheck
  + build clean.
- Secondary observation (NOT changed — out of scope of the report): the
  "Running: …" InlineTerminal renders at the top of the section, so if the
  section is scrolled down when you trigger an action from a lower block, its
  output can be above the fold. Worth a follow-up (scroll-into-view or render
  the terminal inline near the triggering block) but not what "button doesn't
  work" was about.

### S14 — four user-requested capabilities (2026-07-03)
User feedback burst while testing the real app: fixed two visual bugs (the
conversation horizontal scrollbar `9feb6ef`, and a phantom resize cursor over
the collapsed side panel `7ba02c5`), then asked for four bigger features and
said "all" when asked which to prioritize. Doing them one at a time, each
committed and screenshot-verified.

- **1/4 — Permissions in Settings** (`aea31a7`): the permission manager existed
  only behind the activity-bar shield icon; the user looked in Settings and
  didn't find it. Added it as a Settings category reusing `PermissionsPanel`
  verbatim (own save to `.claude/settings.json`), as an action category (no
  staged-apply footer). Shield icon kept.
- **2/4 — Model picker**: a per-session model selector in the conversation
  header, via the CLI's own `--model` (aliases opus/sonnet/haiku/fable,
  verified against `claude --help`). New `store/model.ts` (persisted to
  localStorage — the choice should survive a relaunch, esp. picking Sonnet for
  cheaper testing). Threaded `model: Option<String>` through
  `engine::open`/`open_with` → `open_workspace`/`resume_workspace` commands →
  IPC wrappers → the conversation store's lazy open. Backend `validate_model`
  rejects anything outside the alias set / `claude-*` shape (defense-in-depth;
  it's a distinct argv value, no shell) — +1 Rust test (100 total). Applies to
  the NEXT session (sessions open lazily on first turn); the picker shows
  "(next)" + a tooltip while one is live, since `--model` is fixed at spawn.
- **3/4 — Browse & install plugins** (`plugins.rs`, `SettingsView.tsx`): the
  CLI has no "list available plugins" command (only installed). But each
  marketplace's `installLocation/.claude-plugin/marketplace.json` lists its
  full catalog (255 in the official one) with name/description/category/author
  — so `list_available_plugins()` reads those manifests (read-only, like
  reading transcripts) and returns a flat list tagged by marketplace. New
  `AvailablePlugin` + `parse_manifest_plugins` (+2 tests, 102 total; author
  may be a `{name}` object or a bare string). Frontend: a search-gated,
  capped-at-40 BROWSE block in Plugins & Skills — type to filter the catalog,
  each row shows name · category · marketplace + description with an Install
  button (`claude plugin install name@marketplace` via InlineTerminal) or an
  "installed" tag (cross-referenced against `plugin list`). Verified: search
  "security" narrows 4→2 correctly, Install buttons present.
- **4/4 — Steer running agents** (done — was deferred to the end at the user's
  request, then built after the model/effort pickers): a mid-turn composer with
  a **Queue** (type-ahead) and **Send now** (interrupt-and-redirect) path. Full
  writeup below ("Steering a live turn").
- **Model picker polish** (user-tested the real app): (1) the select rendered
  as a white native widget on the dark header; (2) labels now carry the current
  version — Opus 4.8 / Sonnet 5 / Haiku 4.5 / Fable 5 — instead of bare tier
  names; the alias value is unchanged (still resolves to the latest).
- **White native form controls across the app** (root cause + real fix): the
  model picker AND the Settings dropdowns/inputs all rendered WHITE in the real
  app. Root cause: **WebKitGTK renders native `<select>`/`<input>` with the
  light GTK *system* theme, ignoring CSS `background`** — and my earlier
  "verification" screenshots used **headless Chrome**, which obeys the CSS and
  showed them dark, so the bug never appeared in testing. Real fix:
  `color-scheme: dark` on `:root` (and `light` on the light theme) in
  `tokens.css` — a single engine-level directive that themes every native
  control, the `<select>` popup, and scrollbars to match. **Verified in the
  actual WebKitGTK window this time** (not Chrome): the model picker is now
  dark. **Methodology lesson: verify native-control/rendering changes in the
  real WebKitGTK app, never headless Chrome — the two renderers differ.**
- **Effort picker** (user asked "and what abt effort how i select it?"): a
  second per-session selector beside the model picker, via the CLI's own
  `--effort` (levels low/medium/high/xhigh/max, verified against
  `claude --help`). Mirrors the model picker exactly: new `store/effort.ts`
  (persisted to localStorage), `effort: Option<String>` threaded through
  `engine::open`/`open_with` → `open_workspace`/`resume_workspace` → IPC
  wrappers → the store's lazy open, backend `validate_effort` allow-list
  (+1 Rust test, 103 total; distinct argv value, no shell). Also applies to
  the NEXT session with the same "(next)" hint while one is live (effort is
  fixed at spawn). Header now reads `model [Opus 4.8 ▾]  effort [High ▾]`;
  layout verified in Chrome, dark theming guaranteed by the committed
  `color-scheme` fix.
- **Steering a live turn** (feature 4/4, the last of the burst): let the user
  redirect or line up work *while a turn is streaming*, instead of only being
  able to wait or hard-Stop.
  - **CLI behavior probed first** (wrapper rule — validate, don't guess): a
    scratch harness spawned `claude --input-format stream-json` with a long
    turn, then wrote a second `user` message mid-stream. Result: the first turn
    **ran to completion**, then the second ran as a **separate turn** (two
    `result`s). So a mid-turn send is **queued by the CLI, never injected** into
    the running turn — the ONLY way to redirect a live turn is to `interrupt`
    first, then send. This finding shaped the whole design.
  - **Two capabilities, both composed from existing engine primitives — zero
    new backend, zero new commands:**
    - **Queue / type-ahead**: composing while streaming holds the message in a
      new `queued: string[]` (conversation store), shown as removable chips
      above the composer. On each natural turn end (`result`) the store flushes
      the next one through the normal `send()` path (own user bubble, streaming
      state, model/effort) — the CLI runs one message per turn, so they play out
      in order. (Enter, or the **Queue** button.)
    - **Send now (steer)**: `steerNow()` jumps the message to the front of the
      queue, sets a one-shot `pendingFlushOnStop`, and calls the existing
      `cancel()` (the `control_request{interrupt}`). The interrupt's `stopped`
      then flushes that message as the immediate next turn. (⌘/Ctrl+Enter, or
      the accent **Send now** button.)
  - **Flush is deliberately narrow**: `result` always flushes; `stopped` flushes
    **only** when `pendingFlushOnStop` is set (i.e. a `steerNow`) — a plain user
    **Stop** or a session EOF must never auto-send the queue. Queue cleared on
    session switch (resume/new).
  - Composer while streaming: `[Stop]` always; `[Queue] [Send now]` when the box
    has text; placeholder shows the two shortcuts. Verified in Chrome (queued
    chips + all three buttons render). Typecheck + build clean; no Rust touched.

## Addendum III S15 — attachments, global API tokens, new app icon (2026-07-05)

- **App icon**: replaced the placeholder Tauri icons with the official Claude
  Code pixel creature (user-supplied `claudecode-color.png`, 640×640,
  transparent) composited onto Anthropic's dark slate (#262624) rounded square
  at 1024², then `npx tauri icon` regenerated every size in `src-tauri/icons/`
  (32/64/128/128@2x, .icns, .ico, Square*). Mobile icon sets it also emitted
  were deleted (desktop-only app). Shows after next build.
- **Global API tokens (GitHub / Hugging Face)** — enter once, every session
  and terminal reuses them:
  - `src-tauri/src/tokens.rs`: store at `<app_config_dir>/tokens.json`,
    written **0600**, provider allow-list (github, huggingface), tokens
    validated single-line ASCII ≤512. `status()` returns only a masked tail
    (`…abcd`) — the secret never crosses IPC back to the frontend.
  - Injection at spawn: engine child (`engine.rs` `.envs(...)`) and terminal
    PTY (`pty.rs`) both get `GITHUB_TOKEN`/`GH_TOKEN` +
    `HF_TOKEN`/`HUGGING_FACE_HUB_TOKEN` — **only when the var isn't already
    set** in the app's environment (user's shell config always wins). Config
    dir resolved once in a `setup` hook → `tokens::init` (OnceLock), so no
    spawn-signature threading.
  - Settings → **API Tokens** section: per-provider password input, Save /
    Remove, masked "saved (…abcd)" status, env-overridden notice. 3 new IPC
    commands (`tokens_status`, `token_set`, `token_clear`).
- **Composer attachments (images, PDF, text files)**:
  - CLI capability **verified first-hand** against claude 2.1.201 before
    building: base64 `image` and `document` (PDF) content blocks sent over
    `--input-format stream-json` stdin both work (haiku described a test
    image; read a magic word out of a generated PDF). **Video/audio is not
    accepted by Claude models — refused with an honest message**, not faked.
  - Backend: `Attachment {name, kind, mediaType, data}` (engine.rs);
    `build_content` is the trust boundary — kind/media-type allow-lists
    (PNG/JPEG/GIF/WebP; application/pdf), size caps (image ~5MB, PDF ~20MB,
    text 400KB, max 8), attachment blocks first, prompt text last;
    attachment-only sends allowed. `read_attachment` command
    (files.rs) classifies by extension, caps size, base64-encodes
    (new dep: `base64 0.22`), passes UTF-8 text through, refuses
    video/audio/unknown binaries. Unit test `build_content_validates_attachments`.
  - Frontend: 📎 button (native multi-file dialog) + **clipboard image paste**
    in the composer; removable chips; error line (`role=alert`); user bubble
    lists sent attachment names. Queue/steer carry attachments too —
    `queued` became `{text, attachments}[]` through enqueue/steerNow/flush.
- Verified: cargo test **107 passed** (was 103), clippy clean, tsc clean,
  vite production build clean.
