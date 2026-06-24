/*
 * Git store (spec 5.A.3, Phase 4). Holds the workspace's source-control status
 * for the Source Control panel. Read-only this slice: `refresh()` re-reads
 * `git status` on demand (panel mount, the Refresh button, and after a save).
 * Live fs-watching is a later refinement; mutations (stage/commit) land next.
 */

import { create } from "zustand";
import { gitStatus } from "@/ipc/commands";
import { isIpcError, type GitStatus } from "@/ipc/types";

interface GitState {
  status: GitStatus | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export const useGit = create<GitState>((set) => ({
  status: null,
  loading: false,
  error: null,
  refresh: async () => {
    set({ loading: true, error: null });
    try {
      set({ status: await gitStatus(), loading: false });
    } catch (e) {
      set({
        error: isIpcError(e) ? e.message : "Could not read git status",
        loading: false,
      });
    }
  },
}));
