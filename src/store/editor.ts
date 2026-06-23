/*
 * Editor store (spec 5.A.3). Tracks the open editor tabs, which one is active,
 * and per-tab dirty state — the source of truth for the tab strip. The Monaco
 * models themselves live imperatively in the editor host (one model per path,
 * disposed on close); this store holds only the lightweight tab metadata.
 */

import { create } from "zustand";

export interface EditorTab {
  /** Workspace-relative path — the stable id for the tab and its model. */
  path: string;
  /** Basename, for the tab label. */
  name: string;
}

interface EditorState {
  tabs: EditorTab[];
  activePath: string | null;
  dirty: Record<string, boolean>;
  /** Open a file (adds a tab if new) and focus it. */
  open: (path: string) => void;
  /** Focus an already-open tab. */
  activate: (path: string) => void;
  /** Close a tab; focus falls to the left neighbor (VS Code-style). */
  close: (path: string) => void;
  setDirty: (path: string, dirty: boolean) => void;
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

export const useEditor = create<EditorState>((set, get) => ({
  tabs: [],
  activePath: null,
  dirty: {},

  open: (path) => {
    const { tabs } = get();
    if (!tabs.some((t) => t.path === path)) {
      set({ tabs: [...tabs, { path, name: basename(path) }] });
    }
    set({ activePath: path });
  },

  activate: (path) => set({ activePath: path }),

  close: (path) => {
    const { tabs, activePath, dirty } = get();
    const idx = tabs.findIndex((t) => t.path === path);
    if (idx === -1) return;
    const next = tabs.filter((t) => t.path !== path);
    const { [path]: _closed, ...restDirty } = dirty;
    const nextActive =
      activePath === path
        ? next.length
          ? (next[idx - 1]?.path ?? next[0].path)
          : null
        : activePath;
    set({ tabs: next, activePath: nextActive, dirty: restDirty });
  },

  setDirty: (path, dirty) =>
    set((s) => (s.dirty[path] === dirty ? s : { dirty: { ...s.dirty, [path]: dirty } })),
}));
