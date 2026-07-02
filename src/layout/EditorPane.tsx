/*
 * Editor host (spec 5.A.3). Hosts ONE Monaco editor and gives every open tab its
 * own model — so switching tabs preserves each file's content, scroll, cursor,
 * and undo history, and dirty state is tracked per file via Monaco's undo-aware
 * version id (editing back to the saved state clears dirty, like VS Code). Each
 * model is disposed when its tab closes and all are disposed on unmount — the
 * Phase 4 "no leak" gate. Ctrl/Cmd-S saves the active tab; >2 MB files open
 * read-only so a partial buffer can't clobber the original; binary/unreadable
 * files show a notice instead of garbage.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore, type StoreApi } from "zustand";
import Editor, { type OnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { EmptyState, LoadingState } from "@/components/states";
import {
  AGENT_ACTION_LABELS,
  currentLineContext,
  sendAgentAction,
  sendLineQuestion,
  type AgentActionKind,
} from "@/commands/agentActions";
import { languageForPath } from "@/editor/language";
import { defineClaudeTheme, monacoThemeFor } from "@/editor/monacoSetup";
import { normalizeFinalNewlines, trimTrailingWhitespace } from "@/editor/saveTransforms";
import { checkpointTimeline, readFile, writeFile } from "@/ipc/commands";
import { isIpcError, type CheckpointEntry } from "@/ipc/types";
import { getActiveEditorHandle, setActiveEditorHandle } from "@/store/activeEditorHandle";
import { activeConversationStore } from "@/store/conversation";
import type { EditorState } from "@/store/editor";
import { useEditorStatus } from "@/store/editorStatus";
import { mergeEffective, mergeEffectiveFiles, useSettings, type EffectiveEditor } from "@/store/settings";
import { useTheme } from "@/store/theme";
import { useZoom } from "@/store/zoom";

/** Editor font size bounds (mirrors the backend's clamp in settings.rs). */
const FONT_SIZE_MIN = 6;
const FONT_SIZE_MAX = 72;

/** Map the resolved settings to Monaco's editor-level options. Model-level options
 *  (tabSize / insertSpaces) are applied per-model separately. */
function editorOptions(e: EffectiveEditor): Monaco.editor.IEditorOptions {
  return {
    fontFamily: e.fontFamily,
    fontSize: e.fontSize,
    fontLigatures: e.fontLigatures,
    wordWrap: e.wordWrap,
    wordWrapColumn: e.wordWrapColumn,
    minimap: { enabled: e.minimap },
    formatOnPaste: e.formatOnPaste,
  };
}

/** Static options that never depend on settings (merged under the dynamic ones). */
const STATIC_OPTIONS: Monaco.editor.IStandaloneEditorConstructionOptions = {
  scrollBeyondLastLine: false,
  automaticLayout: true,
  renderLineHighlight: "line",
  padding: { top: 12 },
  fixedOverflowWidgets: true,
};

/** Join a workspace cwd and a root-relative tab path into an absolute path —
 *  the Monaco model URI key, so files with the same relative path in different
 *  workspaces never collide on the shared monaco model registry. */
function absPath(cwd: string, rel: string): string {
  return `${cwd.replace(/\/+$/, "")}/${rel}`;
}

type ContentState =
  | { kind: "loading" }
  | { kind: "ready"; truncated: boolean }
  | { kind: "binary" }
  | { kind: "error"; message: string };

interface ModelEntry {
  model: Monaco.editor.ITextModel;
  savedVersionId: number; // alt version id at last load/save (undo-aware dirty)
  viewState: Monaco.editor.ICodeEditorViewState | null;
  readOnly: boolean;
  changeSub: Monaco.IDisposable;
}

export function EditorPane({
  cwd,
  store,
  active,
}: {
  cwd: string;
  store: StoreApi<EditorState>;
  /** Whether this is the currently-shown workspace's editor (§S3): only the
   *  active one registers itself as the Command Palette's target for
   *  Save/Go-to-Line/editor-zoom. */
  active: boolean;
}) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const modelsRef = useRef<Map<string, ModelEntry>>(new Map());
  const fetchedRef = useRef<Set<string>>(new Set());
  const shownRef = useRef<string | null>(null);
  // Pending "afterDelay" auto-save timers, keyed by tab path (debounced: reset
  // on every keystroke, matching VS Code's `files.autoSave: afterDelay`).
  const autoSaveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Paths whose model is mid-edit from `saveFile`'s own trim/final-newline
  // normalization (not a real user change) — the content-change handler skips
  // dirty-tracking and auto-save scheduling for these, so saving a file can't
  // flicker its dirty dot or schedule a stray auto-save against itself.
  const savingRef = useRef<Set<string>>(new Set());
  // `active` kept fresh for the persistent cursor/selection listeners
  // registered once in onMount (Addendum II §S5 — the Status Bar's live
  // Ln:Col/selection) — they must not update the shared status store for a
  // workspace that isn't the one currently in front.
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const [ready, setReady] = useState(false);
  const [contents, setContents] = useState<Record<string, ContentState>>({});
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});
  // "Compare with Checkpoint…" (Addendum II §S7) — set by a Monaco editor
  // action, consumed by `CheckpointPickerModal` below.
  const [checkpointPicker, setCheckpointPicker] = useState<{ path: string } | null>(null);
  // "Ask About This Line…" (Addendum II §S7) — likewise.
  const [askLine, setAskLine] = useState<{ path: string; line: number } | null>(null);

  const tabs = useStore(store, (s) => s.tabs);
  const activePath = useStore(store, (s) => s.activePath);
  const dirty = useStore(store, (s) => s.dirty);
  const reveal = useStore(store, (s) => s.reveal);
  const monacoTheme = monacoThemeFor(useTheme((s) => s.palette));

  // Effective editor settings for this workspace (DEFAULTS < user < workspace).
  // `userEditor`/`wsEditor` are stable object refs from the store, so the memo
  // only recomputes when a setting actually changes.
  const userEditor = useSettings((s) => s.user.editor);
  const wsEditor = useSettings((s) => s.workspaces[cwd]?.editor);
  const effective = useMemo(() => mergeEffective(userEditor, wsEditor), [userEditor, wsEditor]);
  // Editor-font zoom (§S3): an ephemeral delta layered over the effective
  // (settings-backed) font size — never written back to settings.
  const editorZoomDelta = useZoom((s) => s.editorDelta);
  const options = useMemo<Monaco.editor.IStandaloneEditorConstructionOptions>(() => {
    const fontSize = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, effective.fontSize + editorZoomDelta));
    return { ...STATIC_OPTIONS, ...editorOptions(effective), fontSize };
  }, [effective, editorZoomDelta]);

  const disposeEntry = useCallback((path: string) => {
    const entry = modelsRef.current.get(path);
    if (entry) {
      entry.changeSub.dispose();
      entry.model.dispose();
      modelsRef.current.delete(path);
    }
    const timer = autoSaveTimersRef.current.get(path);
    if (timer) {
      clearTimeout(timer);
      autoSaveTimersRef.current.delete(path);
    }
  }, []);

  /** Push a full status snapshot (cursor, selection, language, indent, EOL) for
   *  `path` to the Status Bar's store — only while this is the active pane. */
  const pushStatusSnapshot = useCallback(
    (entry: ModelEntry, path: string) => {
      if (!active) return;
      const editor = editorRef.current;
      if (!editor) return;
      const pos = editor.getPosition();
      const sel = editor.getSelection();
      const selectionLength = sel ? entry.model.getValueInRange(sel).length : 0;
      const opts = entry.model.getOptions();
      useEditorStatus.getState().set({
        path,
        language: entry.model.getLanguageId(),
        line: pos?.lineNumber ?? 1,
        column: pos?.column ?? 1,
        selectionLength,
        tabSize: opts.tabSize,
        insertSpaces: opts.insertSpaces,
        eol: entry.model.getEOL() === "\r\n" ? "CRLF" : "LF",
      });
    },
    [active],
  );

  /** Save one tab's model to disk: format-on-save first (only when it's the
   *  model currently attached to the editor widget — the format action acts on
   *  whatever the editor is showing), then the trim-whitespace/final-newline
   *  transforms, then write. Shared by manual save (Ctrl/Cmd-S, the Save
   *  button) and every auto-save mode. */
  const saveFile = useCallback(
    async (path: string) => {
      const entry = modelsRef.current.get(path);
      if (!entry || entry.readOnly) return;
      const eff = mergeEffective(useSettings.getState().user.editor, useSettings.getState().workspaces[cwd]?.editor);
      const effFiles = mergeEffectiveFiles(useSettings.getState().user.files, useSettings.getState().workspaces[cwd]?.files);
      const editor = editorRef.current;
      // Format-on-save and the trim/final-newline transforms below edit the
      // model themselves, which would otherwise fire onDidChangeContent like a
      // real keystroke — flickering the dirty dot and scheduling a stray
      // "afterDelay" auto-save against the file we're already saving. Suppress
      // that handler for the duration; `setDirty`/`savedVersionId` below still
      // set the definitive post-save state once we're done.
      savingRef.current.add(path);
      try {
        if (eff.formatOnSave && editor && editor.getModel() === entry.model) {
          await editor.getAction("editor.action.formatDocument")?.run();
        }
        // `files.eol` (Addendum II §S6): "auto" keeps whatever the file (or a
        // manual Status Bar pick) already uses. Monaco owns EOL at the model
        // level, so converting via `setEOL` (not a text-edit regex) is what
        // keeps it consistent with the Status Bar's own EOL segment.
        if (effFiles.eol !== "auto" && monacoRef.current) {
          const wantCrlf = effFiles.eol === "crlf";
          const current = entry.model.getEOL() === "\r\n";
          if (current !== wantCrlf) {
            entry.model.setEOL(
              wantCrlf ? monacoRef.current.editor.EndOfLineSequence.CRLF : monacoRef.current.editor.EndOfLineSequence.LF,
            );
          }
        }
        const before = entry.model.getValue();
        let after = eff.trimTrailingWhitespace
          ? trimTrailingWhitespace(before, languageForPath(path))
          : before;
        after = normalizeFinalNewlines(after, eff.insertFinalNewline, eff.trimFinalNewlines);
        if (after !== before) {
          entry.model.pushEditOperations(null, [{ range: entry.model.getFullModelRange(), text: after }], () => null);
        }
        await writeFile(path, entry.model.getValue(), cwd);
        entry.savedVersionId = entry.model.getAlternativeVersionId();
        store.getState().setDirty(path, false);
        setSaveErrors((c) => {
          if (!(path in c)) return c;
          const next = { ...c };
          delete next[path];
          return next;
        });
      } catch (e) {
        setSaveErrors((c) => ({
          ...c,
          [path]: isIpcError(e) ? e.message : "Save failed",
        }));
      } finally {
        savingRef.current.delete(path);
      }
    },
    [cwd, store],
  );

  const saveActive = useCallback(() => {
    const path = store.getState().activePath;
    return path ? saveFile(path) : Promise.resolve();
  }, [store, saveFile]);

  const loadTab = useCallback(
    async (path: string) => {
    try {
      const file = await readFile(path, cwd);
      if (!fetchedRef.current.has(path)) return; // tab closed mid-fetch
      if (file.binary) {
        setContents((c) => ({ ...c, [path]: { kind: "binary" } }));
        return;
      }
      const monaco = monacoRef.current;
      if (!monaco) return;
      const uri = monaco.Uri.file(absPath(cwd, path));
      const model =
        monaco.editor.getModel(uri) ??
        monaco.editor.createModel(file.text, languageForPath(path), uri);
      // Apply indent settings to the fresh model (a later settings change is
      // applied to every model by the effect below).
      const eff = mergeEffective(useSettings.getState().user.editor, useSettings.getState().workspaces[cwd]?.editor);
      model.updateOptions({ tabSize: eff.tabSize, insertSpaces: eff.insertSpaces });
      const changeSub = model.onDidChangeContent(() => {
        const entry = modelsRef.current.get(path);
        if (!entry) return;
        // Our own format-on-save / trim / final-newline edit, not a real user
        // change — skip dirty-tracking and auto-save scheduling for it (saveFile
        // sets the definitive post-save dirty/savedVersionId itself once done).
        if (savingRef.current.has(path)) return;
        const dirty = model.getAlternativeVersionId() !== entry.savedVersionId;
        store.getState().setDirty(path, dirty);

        // "afterDelay" auto-save: debounce a save, reset on every keystroke.
        const existingTimer = autoSaveTimersRef.current.get(path);
        if (existingTimer) {
          clearTimeout(existingTimer);
          autoSaveTimersRef.current.delete(path);
        }
        const liveEff = mergeEffective(useSettings.getState().user.editor, useSettings.getState().workspaces[cwd]?.editor);
        if (dirty && !entry.readOnly && liveEff.autoSave === "afterDelay") {
          const timer = setTimeout(() => {
            autoSaveTimersRef.current.delete(path);
            if (store.getState().dirty[path]) void saveFile(path);
          }, liveEff.autoSaveDelay);
          autoSaveTimersRef.current.set(path, timer);
        }
      });
      modelsRef.current.set(path, {
        model,
        savedVersionId: model.getAlternativeVersionId(),
        viewState: null,
        readOnly: file.truncated,
        changeSub,
      });
      setContents((c) => ({ ...c, [path]: { kind: "ready", truncated: file.truncated } }));
    } catch (e) {
      if (!fetchedRef.current.has(path)) return;
      setContents((c) => ({
        ...c,
        [path]: { kind: "error", message: isIpcError(e) ? e.message : "Could not read the file" },
      }));
    }
    },
    [cwd, store, saveFile],
  );

  // Reconcile open tabs ↔ loaded models: fetch new tabs, dispose closed ones.
  useEffect(() => {
    if (!ready) return;
    const open = new Set(tabs.map((t) => t.path));
    for (const tab of tabs) {
      if (tab.kind === "diff") continue; // diff tabs render in the diff overlay, not here
      if (fetchedRef.current.has(tab.path)) continue;
      fetchedRef.current.add(tab.path);
      setContents((c) => ({ ...c, [tab.path]: { kind: "loading" } }));
      void loadTab(tab.path);
    }
    for (const path of Array.from(fetchedRef.current)) {
      if (!open.has(path)) {
        fetchedRef.current.delete(path);
        disposeEntry(path);
        setContents((c) => {
          const next = { ...c };
          delete next[path];
          return next;
        });
        setSaveErrors((c) => {
          const next = { ...c };
          delete next[path];
          return next;
        });
      }
    }
  }, [tabs, ready, loadTab, disposeEntry]);

  // Show the active tab: save the previous view state, swap the model, restore.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (shownRef.current && shownRef.current !== activePath) {
      const prev = modelsRef.current.get(shownRef.current);
      if (prev) prev.viewState = editor.saveViewState();
    }
    if (!activePath) return;
    const entry = modelsRef.current.get(activePath);
    if (entry && contents[activePath]?.kind === "ready") {
      if (editor.getModel() !== entry.model) editor.setModel(entry.model);
      if (entry.viewState) editor.restoreViewState(entry.viewState);
      editor.updateOptions({ readOnly: entry.readOnly });
      shownRef.current = activePath;
      pushStatusSnapshot(entry, activePath);
    }
  }, [activePath, contents, ready, pushStatusSnapshot]);

  // Jump to a requested line (e.g. a search hit) once its model is the shown one.
  // Declared after the show-active effect so the model swap has already happened.
  useEffect(() => {
    if (!reveal) return;
    const editor = editorRef.current;
    const entry = modelsRef.current.get(reveal.path);
    if (!editor || !entry) return;
    if (activePath !== reveal.path || contents[reveal.path]?.kind !== "ready") return;
    if (editor.getModel() !== entry.model) return; // wait until this model is shown
    const line = Math.max(1, reveal.line);
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();
    store.getState().clearReveal();
  }, [reveal, activePath, contents, ready, store]);

  // Re-apply indent settings to every open model when they change live. (Font,
  // wrap, and minimap are editor-level and flow through the `options` prop.)
  useEffect(() => {
    if (!ready) return;
    for (const entry of modelsRef.current.values()) {
      entry.model.updateOptions({
        tabSize: effective.tabSize,
        insertSpaces: effective.insertSpaces,
      });
    }
    // The Status Bar's indent segment should reflect a live settings change too.
    if (activePath) {
      const entry = modelsRef.current.get(activePath);
      if (entry) pushStatusSnapshot(entry, activePath);
    }
  }, [effective.tabSize, effective.insertSpaces, ready, contents, activePath, pushStatusSnapshot]);

  // Dispose every model on unmount (the host unmounts when the last tab closes).
  useEffect(() => {
    const models = modelsRef.current;
    return () => {
      for (const path of Array.from(models.keys())) disposeEntry(path);
    };
  }, [disposeEntry]);

  // Auto-save "on window change": if this pane's editor had focus when the OS
  // window itself loses focus (e.g. alt-tabbing away), save its active file.
  useEffect(() => {
    const onWindowBlur = () => {
      const eff = mergeEffective(useSettings.getState().user.editor, useSettings.getState().workspaces[cwd]?.editor);
      if (eff.autoSave !== "onWindowChange") return;
      if (!editorRef.current?.hasTextFocus()) return;
      const path = store.getState().activePath;
      if (path && store.getState().dirty[path]) void saveFile(path);
    };
    window.addEventListener("blur", onWindowBlur);
    return () => window.removeEventListener("blur", onWindowBlur);
  }, [cwd, store, saveFile]);

  // Register this pane as the Command Palette's target (Save / Go to Line /
  // editor zoom) while it's the active workspace's editor. Only clears on
  // cleanup if we're still the one registered — order-independent, so a race
  // between this pane deactivating and another activating can't clobber the
  // newly-active one regardless of effect run order.
  useEffect(() => {
    if (!active || !ready) return;
    const editor = editorRef.current;
    if (!editor) return;
    const handle = {
      editor,
      save: saveActive,
      getActivePath: () => store.getState().activePath,
      setLanguage: (id: string) => {
        const monaco = monacoRef.current;
        const model = editor.getModel();
        if (!monaco || !model) return;
        monaco.editor.setModelLanguage(model, id);
        const p = store.getState().activePath;
        const entry = p ? modelsRef.current.get(p) : undefined;
        if (p && entry) pushStatusSnapshot(entry, p);
      },
      setEol: (eol: "LF" | "CRLF") => {
        const monaco = monacoRef.current;
        const model = editor.getModel();
        if (!monaco || !model) return;
        model.setEOL(eol === "CRLF" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
        const p = store.getState().activePath;
        const entry = p ? modelsRef.current.get(p) : undefined;
        if (p && entry) pushStatusSnapshot(entry, p);
      },
    };
    setActiveEditorHandle(handle);
    // This pane just became the active one — push its currently-shown file's
    // status (the show-active-tab effect only fires on a tab/content change,
    // not on becoming active, so a workspace switch needs its own push here).
    const path = store.getState().activePath;
    const entry = path ? modelsRef.current.get(path) : undefined;
    if (path && entry) pushStatusSnapshot(entry, path);
    return () => {
      if (getActiveEditorHandle() === handle) {
        setActiveEditorHandle(null);
        useEditorStatus.getState().clear();
      }
    };
  }, [active, ready, saveActive, pushStatusSnapshot, store]);

  const state = activePath ? contents[activePath] : undefined;
  const isReadOnly = activePath ? !!modelsRef.current.get(activePath)?.readOnly : false;
  const isDirty = activePath ? !!dirty[activePath] : false;
  const saveError = activePath ? saveErrors[activePath] : undefined;
  const truncated = state?.kind === "ready" && state.truncated;

  return (
    <div className="flex h-full w-full flex-col">
      <Breadcrumb
        path={activePath}
        canSave={isDirty && !isReadOnly && state?.kind === "ready"}
        readOnly={isReadOnly && state?.kind === "ready"}
        onSave={() => void saveActive()}
      />
      {truncated && (
        <Banner text="Large file — showing the first 2 MB, read-only (save disabled to protect the original)." />
      )}
      {saveError && <Banner text={saveError} tone="error" />}
      <div className="relative min-h-0 flex-1">
        <Editor
          height="100%"
          defaultValue=""
          theme={monacoTheme}
          beforeMount={() => defineClaudeTheme()}
          onMount={(editor, monaco) => {
            editorRef.current = editor;
            monacoRef.current = monaco;
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveActive());
            // Auto-save "on focus change": this editor losing text focus (e.g.
            // clicking the terminal, sidebar, or another tab) saves its file.
            editor.onDidBlurEditorText(() => {
              const eff = mergeEffective(useSettings.getState().user.editor, useSettings.getState().workspaces[cwd]?.editor);
              if (eff.autoSave !== "onFocusChange") return;
              const path = store.getState().activePath;
              if (path && store.getState().dirty[path]) void saveFile(path);
            });
            // Agent-bridge (§S4): selection actions in Monaco's own right-click
            // menu and command list (F1), so "ask Claude" is a real, discoverable
            // action on the code itself, not just a palette entry.
            let order = 1;
            for (const kind of ["explain", "refactor", "fix", "tests", "docstring"] as AgentActionKind[]) {
              editor.addAction({
                id: `claude.${kind}`,
                label: `Claude: ${AGENT_ACTION_LABELS[kind]}`,
                contextMenuGroupId: "9_claude",
                contextMenuOrder: order++,
                precondition: "editorHasSelection",
                run: () => sendAgentAction(kind),
              });
            }
            // The one agent-bridge action that works on the cursor's line
            // instead of a selection (§S7) — no `editorHasSelection` precondition.
            editor.addAction({
              id: "claude.askLine",
              label: "Claude: Ask About This Line…",
              contextMenuGroupId: "9_claude",
              contextMenuOrder: order++,
              run: () => {
                const ctx = currentLineContext();
                if (ctx) setAskLine(ctx);
              },
            });
            // Compare with a saved checkpoint (§S7) — reuses the read-only
            // checkpoint timeline (Phase 7 P2) already shown per-session in the
            // Sessions panel, just entered from the file being edited instead.
            editor.addAction({
              id: "checkpoints.compareActiveFile",
              label: "Compare with Checkpoint…",
              contextMenuGroupId: "8_checkpoints",
              contextMenuOrder: 1,
              run: () => {
                const path = store.getState().activePath;
                if (path) setCheckpointPicker({ path });
              },
            });
            // Status Bar (§S5): live Ln:Col + selection length, for whichever
            // workspace is actually in front — `activeRef` (not the `active`
            // prop) since this closure is captured once, at mount.
            editor.onDidChangeCursorPosition((e) => {
              if (!activeRef.current) return;
              useEditorStatus.getState().set({ line: e.position.lineNumber, column: e.position.column });
            });
            editor.onDidChangeCursorSelection((e) => {
              if (!activeRef.current) return;
              const model = editor.getModel();
              const selectionLength = model ? model.getValueInRange(e.selection).length : 0;
              useEditorStatus.getState().set({ selectionLength });
            });
            setReady(true);
          }}
          options={options}
        />
        {state?.kind !== "ready" && (
          <div className="absolute inset-0" style={{ background: "var(--color-bg-recessed)" }}>
            {!state || state.kind === "loading" ? (
              <LoadingState label="Opening…" />
            ) : state.kind === "binary" ? (
              <EmptyState
                title="Binary file"
                hint="This file isn't text, so it can't be shown in the editor."
              />
            ) : (
              <EmptyState title="Couldn't open file" hint={state.message} />
            )}
          </div>
        )}
      </div>
      {checkpointPicker && (
        <CheckpointPickerModal
          path={checkpointPicker.path}
          cwd={cwd}
          onOpen={(sessionId, version) => {
            store.getState().openCheckpointDiff(checkpointPicker.path, sessionId, version);
            setCheckpointPicker(null);
          }}
          onClose={() => setCheckpointPicker(null)}
        />
      )}
      {askLine && (
        <AskLineModal
          path={askLine.path}
          line={askLine.line}
          onClose={() => setAskLine(null)}
          onSend={(question) => {
            sendLineQuestion(question);
            setAskLine(null);
          }}
        />
      )}
    </div>
  );
}

/** "Compare with Checkpoint…" (§S7) — the active session's saved snapshots of
 *  ONE file, newest first, reusing the same read-only checkpoint timeline the
 *  Sessions panel already shows per-session (Phase 7 P2). Picking one opens the
 *  same `openCheckpointDiff` diff tab that panel does. */
function CheckpointPickerModal({
  path,
  cwd,
  onOpen,
  onClose,
}: {
  path: string;
  cwd: string;
  onOpen: (sessionId: string, version: number) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "no-session" }
    | { kind: "error"; message: string }
    | { kind: "ready"; sessionId: string; entries: CheckpointEntry[] }
  >({ kind: "loading" });

  useEffect(() => {
    const sessionId = activeConversationStore().getState().sessionId;
    if (!sessionId) {
      setState({ kind: "no-session" });
      return;
    }
    let alive = true;
    checkpointTimeline(sessionId, cwd)
      .then((timeline) => {
        if (!alive) return;
        setState({
          kind: "ready",
          sessionId,
          entries: timeline.entries.filter((e) => e.path === path),
        });
      })
      .catch((e) => alive && setState({ kind: "error", message: isIpcError(e) ? e.message : "Could not load checkpoints" }));
    return () => {
      alive = false;
    };
  }, [path, cwd]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Compare with checkpoint"
      className="fixed inset-0 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.45)", zIndex: 32 }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div style={{ width: "min(420px, 90%)", maxHeight: "70vh", display: "flex", flexDirection: "column", padding: "var(--space-6)", borderRadius: "var(--radius-lg)", background: "var(--color-bg-overlay)", boxShadow: "var(--elev-3)" }}>
        <p style={{ color: "var(--color-fg-primary)", fontSize: "var(--text-md)", fontWeight: 600 }}>Compare with Checkpoint</p>
        <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)", marginTop: "var(--space-1)" }}>{path}</p>
        <div className="min-h-0 flex-1 overflow-auto" style={{ marginTop: "var(--space-4)" }}>
          {state.kind === "loading" ? (
            <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-sm)" }}>Loading…</p>
          ) : state.kind === "no-session" ? (
            <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-sm)" }}>
              No active session yet — nothing to compare against.
            </p>
          ) : state.kind === "error" ? (
            <p role="alert" style={{ color: "var(--color-status-danger)", fontSize: "var(--text-sm)" }}>{state.message}</p>
          ) : state.entries.length === 0 ? (
            <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-sm)" }}>
              No saved checkpoints for this file in the current session yet.
            </p>
          ) : (
            state.entries.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => onOpen(state.sessionId, e.version)}
                className="flex w-full cursor-pointer items-center justify-between gap-[var(--space-3)] text-left"
                style={{ padding: "var(--space-2) var(--space-3)", border: "none", borderRadius: "var(--radius-sm)", background: "transparent", color: "var(--color-fg-primary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}
                onMouseEnter={(ev) => (ev.currentTarget.style.background = "var(--color-bg-recessed)")}
                onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}
              >
                <span>v{e.version} · {e.tool}</span>
                <span style={{ color: "var(--color-fg-muted)" }}>{new Date(e.timestampMs).toLocaleString()}</span>
              </button>
            ))
          )}
        </div>
        <div className="flex justify-end" style={{ marginTop: "var(--space-5)" }}>
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer"
            style={{ padding: "var(--space-2) var(--space-5)", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border-strong)", background: "transparent", color: "var(--color-fg-primary)", fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)" }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** "Ask About This Line…" (§S7) — the one agent-bridge action that doesn't
 *  need a selection; a free-form question about the cursor's line. `line`
 *  here is only what was showing when the action opened (display context);
 *  `sendLineQuestion` re-reads the live cursor at send time. */
function AskLineModal({
  path,
  line,
  onClose,
  onSend,
}: {
  path: string;
  line: number;
  onClose: () => void;
  onSend: (question: string) => void;
}) {
  const [question, setQuestion] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    const q = question.trim();
    if (!q) return;
    onSend(q);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Ask about this line"
      className="fixed inset-0 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.45)", zIndex: 32 }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit();
        }
      }}
    >
      <div style={{ width: "min(440px, 90%)", padding: "var(--space-6)", borderRadius: "var(--radius-lg)", background: "var(--color-bg-overlay)", boxShadow: "var(--elev-3)" }}>
        <p style={{ color: "var(--color-fg-primary)", fontSize: "var(--text-md)", fontWeight: 600 }}>Ask About This Line</p>
        <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)", marginTop: "var(--space-1)" }}>
          {path} · line {line}
        </p>
        <textarea
          ref={inputRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="What do you want to know about this line?"
          rows={3}
          className="w-full"
          style={{ marginTop: "var(--space-4)", resize: "vertical", padding: "var(--space-3)", border: "1px solid var(--color-border-strong)", borderRadius: "var(--radius-md)", background: "var(--color-bg-base)", color: "var(--color-fg-primary)", fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)" }}
        />
        <div className="flex items-center justify-between" style={{ marginTop: "var(--space-5)" }}>
          <span style={{ color: "var(--color-fg-muted)", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}>Ctrl/Cmd+Enter to send</span>
          <div className="flex gap-[var(--space-3)]">
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer"
              style={{ padding: "var(--space-2) var(--space-5)", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border-strong)", background: "transparent", color: "var(--color-fg-primary)", fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)" }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!question.trim()}
              className="cursor-pointer"
              style={{ padding: "var(--space-2) var(--space-5)", borderRadius: "var(--radius-md)", border: "1px solid var(--color-accent)", background: "var(--color-accent)", color: "var(--color-bg-base)", fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)", fontWeight: 500, opacity: !question.trim() ? 0.5 : 1 }}
            >
              Ask Claude
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Breadcrumb({
  path,
  canSave,
  readOnly,
  onSave,
}: {
  path: string | null;
  canSave: boolean;
  readOnly: boolean;
  onSave: () => void;
}) {
  return (
    <div
      className="flex shrink-0 items-center justify-between gap-[var(--space-3)]"
      style={{
        height: "var(--space-7)",
        padding: "0 var(--space-4)",
        background: "var(--color-bg-recessed)",
        borderBottom: "1px solid var(--color-border-subtle)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        color: "var(--color-fg-muted)",
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {path ?? ""}
        {readOnly && <span style={{ marginLeft: "var(--space-2)" }}>· read-only</span>}
      </span>
      <button
        type="button"
        onClick={onSave}
        disabled={!canSave}
        title="Save (Ctrl/Cmd-S)"
        className={canSave ? "cursor-pointer" : undefined}
        style={{
          border: "none",
          background: "transparent",
          color: canSave ? "var(--color-accent)" : "var(--color-fg-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          opacity: canSave ? 1 : 0.5,
        }}
      >
        Save
      </button>
    </div>
  );
}

function Banner({ text, tone }: { text: string; tone?: "error" }) {
  return (
    <div
      className="shrink-0"
      style={{
        padding: "var(--space-2) var(--space-4)",
        background: "var(--color-bg-recessed)",
        borderBottom: "1px solid var(--color-border-subtle)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        color: tone === "error" ? "var(--color-status-danger)" : "var(--color-fg-muted)",
      }}
    >
      {text}
    </div>
  );
}
