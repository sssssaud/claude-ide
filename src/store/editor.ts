/*
 * Editor store (spec 5.A.3). Tracks which workspace file is open in the editor
 * region. Kept tiny on purpose: the explorer (or, later, a tool card) sets the
 * open path; the editor region reads it and lazy-loads Monaco. Multi-tab + save
 * build on this in the next slice.
 */

import { create } from "zustand";

interface EditorState {
  openPath: string | null;
  open: (path: string) => void;
  close: () => void;
}

export const useEditor = create<EditorState>((set) => ({
  openPath: null,
  open: (path) => set({ openPath: path }),
  close: () => set({ openPath: null }),
}));
