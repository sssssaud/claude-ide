/*
 * A non-reactive handle to whichever workspace's Monaco editor is currently
 * active (Addendum II §S3 — command palette commands like Save / Go to Line /
 * editor zoom need to reach it without plumbing Monaco through React context).
 * Set by the active `EditorPane` on mount, cleared on unmount/deactivation;
 * read imperatively at the moment a command runs, never subscribed to.
 */

import type * as Monaco from "monaco-editor";

export interface ActiveEditorHandle {
  editor: Monaco.editor.IStandaloneCodeEditor;
  save: () => Promise<void>;
}

let current: ActiveEditorHandle | null = null;

export function setActiveEditorHandle(handle: ActiveEditorHandle | null): void {
  current = handle;
}

export function getActiveEditorHandle(): ActiveEditorHandle | null {
  return current;
}
