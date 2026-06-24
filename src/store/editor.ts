/*
 * Editor store (spec 5.A.3). Tracks the open editor tabs, which one is active,
 * and per-tab dirty state — the source of truth for the tab strip. The Monaco
 * models themselves live imperatively in the editor host (one model per path,
 * disposed on close); this store holds only the lightweight tab metadata.
 */

import { create } from "zustand";

export interface EditorTab {
  /** Stable tab id. For a file = its workspace-relative path (and model uri);
   *  for a diff = a synthetic `diff:<staged|working>:<file>` id (never a real
   *  path, so it can't collide with a file tab or be fetched as a file). */
  path: string;
  /** Basename, for the tab label. */
  name: string;
  /** "file" (default) opens in the text editor; "diff" opens a read-only diff. */
  kind?: "file" | "diff";
  /** Present only for diff tabs: which file, and whether the staged diff. */
  diff?: { file: string; staged: boolean };
}

interface EditorState {
  tabs: EditorTab[];
  activePath: string | null;
  dirty: Record<string, boolean>;
  /** Open a file (adds a tab if new) and focus it. */
  open: (path: string) => void;
  /** Open a read-only diff for a file (staged = HEAD→index, else index→worktree). */
  openDiff: (file: string, staged: boolean) => void;
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
      set({ tabs: [...tabs, { path, name: basename(path), kind: "file" }] });
    }
    set({ activePath: path });
  },

  openDiff: (file, staged) => {
    const id = `diff:${staged ? "staged" : "working"}:${file}`;
    const { tabs } = get();
    if (!tabs.some((t) => t.path === id)) {
      set({
        tabs: [...tabs, { path: id, name: basename(file), kind: "diff", diff: { file, staged } }],
      });
    }
    set({ activePath: id });
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
