/*
 * Editor pane (spec 5.A.3). Phase 0 proves Monaco mounts, themes from tokens,
 * and disposes cleanly on unmount (no webview leak). Real file open/edit/save,
 * diff, and multi-tab arrive in Phase 4.
 */

import { useEffect, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { defineClaudeTheme, MONACO_THEME } from "@/editor/monacoSetup";

const WELCOME = `// Claude IDE — editor pane

// Phase 0: Monaco is mounted, themed from the design tokens, and disposed on
// tab close. File explorer, multi-tab editing, save, and git diff land in
// Phase 4.
`;

export function EditorPane({ onClose }: { onClose?: () => void }) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  useEffect(() => {
    // Dispose the model + editor on unmount to avoid leaks (spec 2.5, 5.A.3).
    return () => {
      editorRef.current?.getModel()?.dispose();
      editorRef.current?.dispose();
      editorRef.current = null;
    };
  }, []);

  return (
    <div className="flex h-full w-full flex-col">
      <PaneHeader label="scratch.ts" onClose={onClose} />
      <div className="min-h-0 flex-1">
        <Editor
          height="100%"
          defaultLanguage="typescript"
          defaultValue={WELCOME}
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
      </div>
    </div>
  );
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
      <span>{label}</span>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close buffer"
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
