/*
 * Live editor status (Addendum II §S5) for the Status Bar: cursor position,
 * selection length, language, indent, and line ending of whichever file is
 * showing in the ACTIVE workspace's editor. Reactive (unlike
 * `activeEditorHandle`, which is read imperatively) — the Status Bar
 * subscribes to it and re-renders as the cursor moves. `EditorPane` is the
 * only writer, and only while it's the active pane.
 */

import { create } from "zustand";

export interface EditorStatus {
  path: string | null;
  language: string | null;
  line: number;
  column: number;
  /** Character count of the current selection; 0 = no selection. */
  selectionLength: number;
  tabSize: number;
  insertSpaces: boolean;
  eol: "LF" | "CRLF";
}

const EMPTY: EditorStatus = {
  path: null,
  language: null,
  line: 1,
  column: 1,
  selectionLength: 0,
  tabSize: 2,
  insertSpaces: true,
  eol: "LF",
};

interface EditorStatusStore extends EditorStatus {
  set: (partial: Partial<EditorStatus>) => void;
  clear: () => void;
}

export const useEditorStatus = create<EditorStatusStore>((set) => ({
  ...EMPTY,
  set: (partial) => set(partial),
  clear: () => set(EMPTY),
}));
