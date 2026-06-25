/*
 * Workspaces store (spec 2.5, Phase 5). The open workspaces shown as tabs, and
 * which one is active. A workspace is just a folder root (its absolute path is
 * its id and the cwd every region routes through). This store owns identity and
 * selection only; each workspace's live engine session, terminal, editor tabs,
 * and conversation are kept alive in their own per-workspace stores keyed by
 * this id. The tab list + active selection persist across reloads; the first
 * run is seeded from the backend's default (launch) workspace so the bar is
 * never empty.
 */

import { create } from "zustand";
import { defaultWorkspace } from "@/ipc/commands";

export interface Workspace {
  /** Absolute path — also the stable id and the cwd routed to the backend. */
  id: string;
  path: string;
  /** Basename, for the tab label. */
  name: string;
}

const STORAGE_KEY = "ide:workspaces";

interface Persisted {
  workspaces: Workspace[];
  activeId: string | null;
}

function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed || path;
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { workspaces: [], activeId: null };
    const saved = JSON.parse(raw) as Partial<Persisted>;
    const workspaces = Array.isArray(saved.workspaces)
      ? saved.workspaces.filter(
          (w): w is Workspace =>
            !!w && typeof w.id === "string" && typeof w.path === "string" && typeof w.name === "string",
        )
      : [];
    const activeId =
      typeof saved.activeId === "string" && workspaces.some((w) => w.id === saved.activeId)
        ? saved.activeId
        : (workspaces[0]?.id ?? null);
    return { workspaces, activeId };
  } catch {
    return { workspaces: [], activeId: null };
  }
}

function persist(workspaces: Workspace[], activeId: string | null) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ workspaces, activeId } satisfies Persisted));
  } catch {
    /* storage unavailable — tabs just won't persist this run */
  }
}

interface WorkspacesState extends Persisted {
  /** False until the first-run seed has resolved, so the shell can hold a beat. */
  ready: boolean;
  /** Seed the launch workspace on first run (no-op once any workspace exists). */
  bootstrap: () => Promise<void>;
  /** Add a folder (dedup by path) and focus it. */
  add: (path: string) => void;
  /** Focus an already-open workspace. */
  activate: (id: string) => void;
  /** Close a workspace; focus falls to the left neighbor. The last one stays. */
  close: (id: string) => void;
}

export const useWorkspaces = create<WorkspacesState>((set, get) => {
  const initial = load();

  const commit = (workspaces: Workspace[], activeId: string | null) => {
    persist(workspaces, activeId);
    set({ workspaces, activeId });
  };

  return {
    ...initial,
    ready: initial.workspaces.length > 0,

    bootstrap: async () => {
      if (get().workspaces.length > 0) {
        set({ ready: true });
        return;
      }
      try {
        const path = await defaultWorkspace();
        // A folder may have been added (e.g. via picker) while this resolved.
        if (get().workspaces.length > 0) {
          set({ ready: true });
          return;
        }
        const ws: Workspace = { id: path, path, name: basename(path) };
        persist([ws], ws.id);
        set({ workspaces: [ws], activeId: ws.id, ready: true });
      } catch {
        // Mark ready anyway so the shell renders its empty-folder affordance
        // instead of hanging on a failed seed.
        set({ ready: true });
      }
    },

    add: (path) => {
      const { workspaces } = get();
      const existing = workspaces.find((w) => w.path === path);
      if (existing) {
        commit(workspaces, existing.id);
        return;
      }
      const ws: Workspace = { id: path, path, name: basename(path) };
      commit([...workspaces, ws], ws.id);
    },

    activate: (id) => {
      const { workspaces, activeId } = get();
      if (id === activeId || !workspaces.some((w) => w.id === id)) return;
      commit(workspaces, id);
    },

    close: (id) => {
      const { workspaces, activeId } = get();
      if (workspaces.length <= 1) return; // always keep at least one open
      const idx = workspaces.findIndex((w) => w.id === id);
      if (idx === -1) return;
      const next = workspaces.filter((w) => w.id !== id);
      const nextActive = activeId === id ? (next[idx - 1]?.id ?? next[0].id) : activeId;
      commit(next, nextActive);
    },
  };
});

/** The active workspace's cwd (absolute path), or undefined before bootstrap. */
export function useActiveCwd(): string | undefined {
  return useWorkspaces((s) => s.workspaces.find((w) => w.id === s.activeId)?.path);
}

/** Non-reactive read of the active cwd, for store internals (e.g. the git store
 *  that routes every command through the active workspace root). */
export function activeCwd(): string | undefined {
  const s = useWorkspaces.getState();
  return s.workspaces.find((w) => w.id === s.activeId)?.path;
}
