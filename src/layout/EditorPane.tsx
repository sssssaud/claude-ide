/*
 * Editor pane (spec 5.A.3). Loads a workspace file (via the root-confined
 * `read_file`) and shows it in Monaco, themed from the design tokens and
 * highlighted by extension. Edits are saved back with `write_file` (Ctrl/Cmd-S
 * or the Save button); a dot marks unsaved changes. Truncated (>2 MB) files are
 * read-only so a partial buffer can never clobber the original. The model +
 * editor are disposed on unmount, and the pane unmounts whenever the open file
 * changes (the region gates on a non-null path), so each file gets a fresh,
 * leak-free Monaco instance. Multi-tab lands in a later slice.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { EmptyState, LoadingState } from "@/components/states";
import { defineClaudeTheme, MONACO_THEME } from "@/editor/monacoSetup";
import { readFile, writeFile } from "@/ipc/commands";
import type { FileContents } from "@/ipc/types";
import { isIpcError } from "@/ipc/types";
import { useEditor } from "@/store/editor";

export function EditorPane({ path }: { path: string }) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const baselineRef = useRef(""); // last loaded/saved text — the dirty baseline
  const [file, setFile] = useState<FileContents | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const close = useEditor((s) => s.close);

  // Fetch the file whenever the open path changes.
  useEffect(() => {
    let alive = true;
    setFile(null);
    setError(null);
    setDirty(false);
    setSaveError(null);
    readFile(path)
      .then((f) => {
        if (!alive) return;
        baselineRef.current = f.text;
        setFile(f);
      })
      .catch((e) => alive && setError(isIpcError(e) ? e.message : "Could not read the file"));
    return () => {
      alive = false;
    };
  }, [path]);

  // Dispose the model + editor on unmount to avoid a webview leak (spec 2.5).
  useEffect(() => {
    return () => {
      editorRef.current?.getModel()?.dispose();
      editorRef.current?.dispose();
      editorRef.current = null;
    };
  }, []);

  const save = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) return;
    const text = editor.getValue();
    try {
      await writeFile(path, text);
      baselineRef.current = text;
      setDirty(false);
      setSaveError(null);
    } catch (e) {
      setSaveError(isIpcError(e) ? e.message : "Save failed");
    }
  }, [path]);

  const readOnly = file?.truncated ?? false;
  const name = path.split("/").pop() ?? path;

  return (
    <div className="flex h-full w-full flex-col">
      <PaneHeader label={path} dirty={dirty} canSave={dirty && !readOnly} onSave={save} onClose={close} />
      {readOnly && file && (
        <Banner text="Large file — showing the first 2 MB, read-only (saving is disabled to protect the original)." />
      )}
      {saveError && <Banner text={saveError} tone="error" />}
      <div className="min-h-0 flex-1">
        {error ? (
          <EmptyState title="Couldn't open file" hint={error} />
        ) : file === null ? (
          <LoadingState label={`Opening ${name}…`} />
        ) : file.binary ? (
          <EmptyState
            title="Binary file"
            hint="This file isn't text, so it can't be shown in the editor."
          />
        ) : (
          <Editor
            height="100%"
            defaultValue={file.text}
            language={languageForPath(path)}
            theme={MONACO_THEME}
            beforeMount={() => defineClaudeTheme()}
            onMount={(editor, monaco) => {
              editorRef.current = editor;
              // Ctrl/Cmd-S saves (and suppresses the browser's save dialog).
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save());
            }}
            onChange={(value) => setDirty((value ?? "") !== baselineRef.current)}
            options={{
              readOnly,
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              renderLineHighlight: "line",
              padding: { top: 12 },
              // Render suggestion/hover popups in a fixed layer so they aren't
              // clipped by the editor pane's `overflow:hidden` when it's narrow.
              fixedOverflowWidgets: true,
            }}
          />
        )}
      </div>
    </div>
  );
}

/** Monaco language id by file extension; falls back to plaintext. */
function languageForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    rs: "rust",
    py: "python",
    md: "markdown",
    markdown: "markdown",
    css: "css",
    scss: "scss",
    less: "less",
    html: "html",
    htm: "html",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    toml: "ini",
    ini: "ini",
    sh: "shell",
    bash: "shell",
    sql: "sql",
    go: "go",
    c: "c",
    h: "c",
    cpp: "cpp",
    java: "java",
  };
  return map[ext] ?? "plaintext";
}

function PaneHeader({
  label,
  dirty,
  canSave,
  onSave,
  onClose,
}: {
  label: string;
  dirty: boolean;
  canSave: boolean;
  onSave: () => void;
  onClose?: () => void;
}) {
  return (
    <div
      className="flex shrink-0 items-center justify-between gap-[var(--space-3)]"
      style={{
        height: "var(--space-7)",
        padding: "0 var(--space-4)",
        background: "var(--color-bg-raised)",
        borderBottom: "1px solid var(--color-border-subtle)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        color: "var(--color-fg-secondary)",
      }}
    >
      <span
        className="flex items-center gap-[var(--space-2)]"
        style={{ minWidth: 0 }}
      >
        {dirty && (
          <span
            aria-label="Unsaved changes"
            title="Unsaved changes"
            style={{
              width: "7px",
              height: "7px",
              borderRadius: "50%",
              background: "var(--color-status-running)",
              flexShrink: 0,
            }}
          />
        )}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {label}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-[var(--space-3)]">
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
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close file"
            className="cursor-pointer"
            style={{
              border: "none",
              background: "transparent",
              color: "var(--color-fg-muted)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-sm)",
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        )}
      </span>
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
