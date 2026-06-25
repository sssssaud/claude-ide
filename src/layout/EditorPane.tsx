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

import { useCallback, useEffect, useRef, useState } from "react";
import { useStore, type StoreApi } from "zustand";
import Editor, { type OnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { EmptyState, LoadingState } from "@/components/states";
import { languageForPath } from "@/editor/language";
import { defineClaudeTheme, MONACO_THEME } from "@/editor/monacoSetup";
import { readFile, writeFile } from "@/ipc/commands";
import { isIpcError } from "@/ipc/types";
import type { EditorState } from "@/store/editor";

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

  const [ready, setReady] = useState(false);
  const [contents, setContents] = useState<Record<string, ContentState>>({});
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});

  const tabs = useStore(store, (s) => s.tabs);
  const activePath = useStore(store, (s) => s.activePath);
  const dirty = useStore(store, (s) => s.dirty);
  const reveal = useStore(store, (s) => s.reveal);

  const disposeEntry = useCallback((path: string) => {
    const entry = modelsRef.current.get(path);
    if (entry) {
      entry.changeSub.dispose();
      entry.model.dispose();
      modelsRef.current.delete(path);
    }
  }, []);

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
      const changeSub = model.onDidChangeContent(() => {
        const entry = modelsRef.current.get(path);
        if (!entry) return;
        store
          .getState()
          .setDirty(path, model.getAlternativeVersionId() !== entry.savedVersionId);
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
    [cwd, store],
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

  // Dispose every model on unmount (the host unmounts when the last tab closes).
  useEffect(() => {
    const models = modelsRef.current;
    return () => {
      for (const path of Array.from(models.keys())) disposeEntry(path);
    };
  }, [disposeEntry]);

  const saveActive = useCallback(async () => {
    const path = store.getState().activePath;
    if (!path) return;
    const entry = modelsRef.current.get(path);
    if (!entry || entry.readOnly) return;
    try {
      await writeFile(path, entry.model.getValue(), cwd);
      entry.savedVersionId = entry.model.getAlternativeVersionId();
      store.getState().setDirty(path, false);
      setSaveErrors((c) => {
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
  }, [cwd, store]);

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
          theme={MONACO_THEME}
          beforeMount={() => defineClaudeTheme()}
          onMount={(editor, monaco) => {
            editorRef.current = editor;
            monacoRef.current = monaco;
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveActive());
            setReady(true);
          }}
          options={{
            fontFamily: "var(--font-mono)",
            fontSize: 15,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            renderLineHighlight: "line",
            padding: { top: 12 },
            fixedOverflowWidgets: true,
          }}
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
