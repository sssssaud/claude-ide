/*
 * Editor store (spec 5.A.3). Tracks the open editor tabs, which one is active,
 * and per-tab dirty state — the source of truth for the tab strip. The Monaco
 * models themselves live imperatively in the editor host (one model per path,
 * disposed on close); this store holds only the lightweight tab metadata.
 *
 * Phase 5 (B5): one store PER workspace (keyed by cwd), so each workspace keeps
 * its own open tabs / active tab / dirty set. Switching workspaces is instant
 * and never bleeds tabs across projects. The body is identical to the
 * single-workspace store it grew from — wrapping it in a factory is the only
 * change. The active workspace's store is what the explorer/search/git act on
 * (`useActiveEditor`); each workspace's own host instance binds to its store via
 * `editorStoreFor`.
 */

import { createStore, useStore, type StoreApi } from "zustand";
import { useWorkspaces } from "@/store/workspaces";

/** The stable id of the Settings tab (a synthetic, non-path id so it can never
 *  collide with a real file tab or be fetched as a file). */
export const SETTINGS_TAB_ID = "settings:app";

export interface EditorTab {
  /** Stable tab id. For a file = its workspace-relative path (and model uri);
   *  for a diff = a synthetic `diff:…` / `ckpt:…` id; for Settings = the fixed
   *  `SETTINGS_TAB_ID` (never a real path, so it can't collide with a file). */
  path: string;
  /** Basename, for the tab label. */
  name: string;
  /** "file" (default) opens in the text editor; "diff" a read-only diff;
   *  "settings" the Settings surface. */
  kind?: "file" | "diff" | "settings";
  /** Present only for diff tabs: which file, whether the staged git diff, and —
   *  for a checkpoint preview (Phase 7 P2) — the session + version to compare
   *  the saved snapshot against the current file (read-only, no restore). */
  diff?: {
    file: string;
    staged: boolean;
    checkpoint?: { sessionId: string; version: number };
  };
}

export interface EditorState {
  tabs: EditorTab[];
  activePath: string | null;
  dirty: Record<string, boolean>;
  /** A pending "jump to this line" request the editor host consumes once the
   *  file's model is shown (used by global search). 1-based line. */
  reveal: { path: string; line: number } | null;
  /** Open a file (adds a tab if new) and focus it. */
  open: (path: string) => void;
  /** Open a file and reveal `line` (1-based) — e.g. a search hit. */
  openAt: (path: string, line: number) => void;
  /** Open a read-only diff for a file (staged = HEAD→index, else index→worktree). */
  openDiff: (file: string, staged: boolean) => void;
  /** Open a read-only checkpoint preview: a session's saved snapshot of `file`
   *  at `version` vs the current file (Phase 7 P2; no restore). */
  openCheckpointDiff: (file: string, sessionId: string, version: number) => void;
  /** Open (or focus) the Settings tab. */
  openSettings: () => void;
  /** Focus an already-open tab. */
  activate: (path: string) => void;
  /** Close a tab; focus falls to the left neighbor (VS Code-style). */
  close: (path: string) => void;
  setDirty: (path: string, dirty: boolean) => void;
  /** Clear a consumed reveal request. */
  clearReveal: () => void;
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

const makeEditorStore = (): StoreApi<EditorState> =>
  createStore<EditorState>((set, get) => ({
    tabs: [],
    activePath: null,
    dirty: {},
    reveal: null,

    open: (path) => {
      const { tabs } = get();
      if (!tabs.some((t) => t.path === path)) {
        set({ tabs: [...tabs, { path, name: basename(path), kind: "file" }] });
      }
      set({ activePath: path, reveal: null });
    },

    openAt: (path, line) => {
      const { tabs } = get();
      if (!tabs.some((t) => t.path === path)) {
        set({ tabs: [...tabs, { path, name: basename(path), kind: "file" }] });
      }
      set({ activePath: path, reveal: { path, line } });
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

    openCheckpointDiff: (file, sessionId, version) => {
      const id = `ckpt:${sessionId}:${version}:${file}`;
      const { tabs } = get();
      if (!tabs.some((t) => t.path === id)) {
        set({
          tabs: [
            ...tabs,
            {
              path: id,
              name: `${basename(file)} @v${version}`,
              kind: "diff",
              diff: { file, staged: false, checkpoint: { sessionId, version } },
            },
          ],
        });
      }
      set({ activePath: id });
    },

    openSettings: () => {
      const { tabs } = get();
      if (!tabs.some((t) => t.path === SETTINGS_TAB_ID)) {
        set({ tabs: [...tabs, { path: SETTINGS_TAB_ID, name: "Settings", kind: "settings" }] });
      }
      set({ activePath: SETTINGS_TAB_ID });
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

    clearReveal: () => set({ reveal: null }),
  }));

// ---- Per-workspace registry + active-workspace access ----------------------
// id === the workspace's absolute path (also its cwd). Stores are created
// lazily on first use and kept alive across tab switches, so each workspace's
// open tabs / active tab / dirty set persist — switching is instant and never
// bleeds tabs between projects.
const stores = new Map<string, StoreApi<EditorState>>();
// A stable, inert store for the brief pre-bootstrap window with no active
// workspace yet.
const emptyStore = makeEditorStore();

/** The editor store for a specific workspace cwd (created on first use). */
export function editorStoreFor(cwd: string): StoreApi<EditorState> {
  let store = stores.get(cwd);
  if (!store) {
    store = makeEditorStore();
    stores.set(cwd, store);
  }
  return store;
}

/** The active workspace's editor store — for imperative access (host, getState). */
export function activeEditorStore(): StoreApi<EditorState> {
  const id = useWorkspaces.getState().activeId;
  return id ? editorStoreFor(id) : emptyStore;
}

/** Select from the active workspace's editor store. Re-subscribes when the
 *  active workspace changes, so the explorer/search/git always act on it. */
export function useActiveEditor<T>(selector: (s: EditorState) => T): T {
  const activeId = useWorkspaces((s) => s.activeId);
  return useStore(activeId ? editorStoreFor(activeId) : emptyStore, selector);
}

// When a workspace tab closes, drop its editor store so its tab metadata isn't
// retained. The host instance for that workspace unmounts on close and disposes
// its Monaco models there (the Phase 4 "no leak" gate); this just frees the
// lightweight store.
let knownIds = new Set(useWorkspaces.getState().workspaces.map((w) => w.id));
useWorkspaces.subscribe((state) => {
  const ids = new Set(state.workspaces.map((w) => w.id));
  for (const id of knownIds) {
    if (!ids.has(id)) stores.delete(id);
  }
  knownIds = ids;
});
