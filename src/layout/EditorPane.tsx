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
import { languageForPath } from "@/editor/language";
import { defineClaudeTheme, monacoThemeFor } from "@/editor/monacoSetup";
import { normalizeFinalNewlines, trimTrailingWhitespace } from "@/editor/saveTransforms";
import { readFile, writeFile } from "@/ipc/commands";
import { isIpcError } from "@/ipc/types";
import type { EditorState } from "@/store/editor";
import { mergeEffective, useSettings, type EffectiveEditor } from "@/store/settings";
import { useTheme } from "@/store/theme";

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

export function EditorPane({ cwd, store }: { cwd: string; store: StoreApi<EditorState> }) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const modelsRef = useRef<Map<string, ModelEntry>>(new Map());
  const fetchedRef = useRef<Set<string>>(new Set());
  const shownRef = useRef<string | null>(null);
  // Pending "afterDelay" auto-save timers, keyed by tab path (debounced: reset
  // on every keystroke, matching VS Code's `files.autoSave: afterDelay`).
  const autoSaveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const [ready, setReady] = useState(false);
  const [contents, setContents] = useState<Record<string, ContentState>>({});
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});

  const tabs = useStore(store, (s) => s.tabs);
  const activePath = useStore(store, (s) => s.activePath);
  const dirty = useStore(store, (s) => s.dirty);
  const reveal = useStore(store, (s) => s.reveal);
  const monacoTheme = monacoThemeFor(useTheme((s) => s.palette));

  // Effective editor settings for this workspace (DEFAULTS < user < workspace).
  // `userEditor`/`wsEditor` are stable object refs from the store, so the memo
  // only recomputes when a setting actually changes.
  const userEditor = useSettings((s) => s.user);
  const wsEditor = useSettings((s) => s.workspaces[cwd]);
  const effective = useMemo(() => mergeEffective(userEditor, wsEditor), [userEditor, wsEditor]);
  const options = useMemo<Monaco.editor.IStandaloneEditorConstructionOptions>(
    () => ({ ...STATIC_OPTIONS, ...editorOptions(effective) }),
    [effective],
  );

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

  /** Save one tab's model to disk: format-on-save first (only when it's the
   *  model currently attached to the editor widget — the format action acts on
   *  whatever the editor is showing), then the trim-whitespace/final-newline
   *  transforms, then write. Shared by manual save (Ctrl/Cmd-S, the Save
   *  button) and every auto-save mode. */
  const saveFile = useCallback(
    async (path: string) => {
      const entry = modelsRef.current.get(path);
      if (!entry || entry.readOnly) return;
      const eff = mergeEffective(useSettings.getState().user, useSettings.getState().workspaces[cwd]);
      const editor = editorRef.current;
      try {
        if (eff.formatOnSave && editor && editor.getModel() === entry.model) {
          await editor.getAction("editor.action.formatDocument")?.run();
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
      const eff = mergeEffective(useSettings.getState().user, useSettings.getState().workspaces[cwd]);
      model.updateOptions({ tabSize: eff.tabSize, insertSpaces: eff.insertSpaces });
      const changeSub = model.onDidChangeContent(() => {
        const entry = modelsRef.current.get(path);
        if (!entry) return;
        const dirty = model.getAlternativeVersionId() !== entry.savedVersionId;
        store.getState().setDirty(path, dirty);

        // "afterDelay" auto-save: debounce a save, reset on every keystroke.
        const existingTimer = autoSaveTimersRef.current.get(path);
        if (existingTimer) {
          clearTimeout(existingTimer);
          autoSaveTimersRef.current.delete(path);
        }
        const liveEff = mergeEffective(useSettings.getState().user, useSettings.getState().workspaces[cwd]);
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
    }
  }, [activePath, contents, ready]);

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
  }, [effective.tabSize, effective.insertSpaces, ready, contents]);

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
      const eff = mergeEffective(useSettings.getState().user, useSettings.getState().workspaces[cwd]);
      if (eff.autoSave !== "onWindowChange") return;
      if (!editorRef.current?.hasTextFocus()) return;
      const path = store.getState().activePath;
      if (path && store.getState().dirty[path]) void saveFile(path);
    };
    window.addEventListener("blur", onWindowBlur);
    return () => window.removeEventListener("blur", onWindowBlur);
  }, [cwd, store, saveFile]);

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
              const eff = mergeEffective(useSettings.getState().user, useSettings.getState().workspaces[cwd]);
              if (eff.autoSave !== "onFocusChange") return;
              const path = store.getState().activePath;
              if (path && store.getState().dirty[path]) void saveFile(path);
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
