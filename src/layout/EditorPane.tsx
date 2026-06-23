/*
 * Editor pane (spec 5.A.3). Loads a workspace file (via the root-confined
 * `read_file`) and shows it in Monaco, themed from the design tokens and
 * highlighted by extension. The model + editor are disposed on unmount — and
 * because the pane unmounts whenever the open file changes (the region gates on
 * a non-null path), each file gets a fresh, leak-free Monaco instance. Edits are
 * in-buffer only; save / multi-tab land in the next slice.
 */

import { useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { EmptyState, LoadingState } from "@/components/states";
import { defineClaudeTheme, MONACO_THEME } from "@/editor/monacoSetup";
import { readFile } from "@/ipc/commands";
import type { FileContents } from "@/ipc/types";
import { isIpcError } from "@/ipc/types";
import { useEditor } from "@/store/editor";

export function EditorPane({ path }: { path: string }) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const [file, setFile] = useState<FileContents | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = useEditor((s) => s.close);

  // Fetch the file whenever the open path changes.
  useEffect(() => {
    let alive = true;
    setFile(null);
    setError(null);
    readFile(path)
      .then((f) => alive && setFile(f))
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

  const name = path.split("/").pop() ?? path;

  return (
    <div className="flex h-full w-full flex-col">
      <PaneHeader label={path} onClose={close} />
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
            onMount={(editor) => {
              editorRef.current = editor;
            }}
            options={{
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              renderLineHighlight: "line",
              padding: { top: 12 },
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

function PaneHeader({ label, onClose }: { label: string; onClose?: () => void }) {
  return (
    <div
      className="flex shrink-0 items-center justify-between"
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
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
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
    </div>
  );
}
