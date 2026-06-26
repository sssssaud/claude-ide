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

let themeDefined = false;

/** Define the Monaco editor themes — one per app palette (Phase 10). Colors are
 *  literal hexes that mirror the design tokens (Monaco needs literals, and the
 *  themes are defined once, decoupled from the live `data-theme` state).
 *  Idempotent. */
export function defineClaudeTheme() {
  if (themeDefined) return;
  // Dark (also used by the Midnight palette — both are near-black surfaces).
  monaco.editor.defineTheme("claude-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#0f1115",
      "editor.foreground": "#e6e8ec",
      "editorLineNumber.foreground": "#6b7280",
      "editorLineNumber.activeForeground": "#9aa1ad",
      "editor.lineHighlightBackground": "#15171c",
      "editorCursor.foreground": "#e9a04a",
      "editorGutter.background": "#0f1115",
      "editorWidget.background": "#22262e",
      "editor.selectionBackground": "#e9a04a1f",
    },
  });
  monaco.editor.defineTheme("claude-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#1b1e24",
      "editorLineNumber.foreground": "#9aa1ad",
      "editorLineNumber.activeForeground": "#545a63",
      "editor.lineHighlightBackground": "#eef0f3",
      "editorCursor.foreground": "#b8730f",
      "editorGutter.background": "#ffffff",
      "editorWidget.background": "#ffffff",
      "editor.selectionBackground": "#b8730f29",
    },
  });
  themeDefined = true;
}

/** Default theme name (dark). Prefer `monacoThemeFor(palette)` for theme-aware UI. */
export const MONACO_THEME = "claude-dark";

/** The Monaco theme name for an app palette (Midnight reuses the dark editor). */
export function monacoThemeFor(palette: string): string {
  return palette === "light" ? "claude-light" : "claude-dark";
}
