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
  /** The workspace-relative path of whichever tab is currently shown, read
   *  fresh each call — the editor instance is shared across a workspace's
   *  tabs, so this can change (on tab switch) without the handle itself being
   *  re-registered. `null` if nothing's open (shouldn't happen while a pane
   *  registers itself, but keeps this honest). */
  getActivePath: () => string | null;
  /** Change the active file's Monaco language mode (Status Bar's language
   *  picker, §S5). Routed through here rather than importing `monaco-editor`
   *  into callers, which would pull it out of its lazy chunk. */
  setLanguage: (id: string) => void;
  /** Change the active file's line-ending style (Status Bar's EOL segment, §S5). */
  setEol: (eol: "LF" | "CRLF") => void;
}

let current: ActiveEditorHandle | null = null;

export function setActiveEditorHandle(handle: ActiveEditorHandle | null): void {
  current = handle;
}

export function getActiveEditorHandle(): ActiveEditorHandle | null {
  return current;
}
