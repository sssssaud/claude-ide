/*
 * Monaco setup (spec 5.A.3). Two things must be correct for a Tauri app:
 *  1. Load Monaco from the local npm package, never a CDN — the CSP serves no
 *     remote content (spec 2.8), and the user prefers offline/local.
 *  2. Wire web workers via Vite's `?worker` imports so language services run off
 *     the UI thread (workers are blob/self-origin, allowed by the CSP).
 *
 * Imported once (side-effecting) before any editor mounts.
 */

import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";

import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

const monacoEnv: monaco.Environment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

// Assign the global Monaco picks up for worker creation. Cast avoids depending
// on how monaco-editor declares the global across versions.
(globalThis as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment =
  monacoEnv;

// Use the bundled Monaco instead of the default CDN loader.
loader.config({ monaco });

/** Read a CSS token value so Monaco's theme (which needs literal hex) stays
 *  sourced from tokens.css — the single source of truth. */
function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

let themeDefined = false;

/** Define the "claude-dark" Monaco theme from the design tokens. Idempotent. */
export function defineClaudeTheme() {
  if (themeDefined) return;
  monaco.editor.defineTheme("claude-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": token("--color-bg-recessed"),
      "editor.foreground": token("--color-fg-primary"),
      "editorLineNumber.foreground": token("--color-fg-muted"),
      "editorLineNumber.activeForeground": token("--color-fg-secondary"),
      "editor.lineHighlightBackground": token("--color-bg-base"),
      "editorCursor.foreground": token("--color-accent"),
      "editorGutter.background": token("--color-bg-recessed"),
      "editorWidget.background": token("--color-bg-overlay"),
      "editor.selectionBackground": token("--color-accent-quiet"),
    },
  });
  themeDefined = true;
}

export const MONACO_THEME = "claude-dark";
