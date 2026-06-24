/*
 * Git store (spec 5.A.3, Phase 4). Holds the workspace's source-control status
 * for the Source Control panel and exposes the non-destructive mutations
 * (stage / unstage), each of which refreshes the status afterward. Commit lives
 * in the panel (it needs a message + success feedback). Live fs-watching is a
 * later refinement; destructive ops (discard) are a later, confirm-gated slice.
 */

import { create } from "zustand";
import { gitStage, gitStageAll, gitStatus, gitUnstage, gitUnstageAll } from "@/ipc/commands";
import { isIpcError, type GitStatus } from "@/ipc/types";

interface GitState {
  status: GitStatus | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  stage: (path: string) => Promise<void>;
  unstage: (path: string) => Promise<void>;
  stageAll: () => Promise<void>;
  unstageAll: () => Promise<void>;
}

export const useGit = create<GitState>((set, get) => {
  // Run a mutation, surface any error, then re-read status so the panel reflects
  // the new index/working-tree state.
  const mutate = async (op: () => Promise<unknown>) => {
    try {
      await op();
      set({ error: null });
    } catch (e) {
      set({ error: isIpcError(e) ? e.message : "Git operation failed" });
    }
    await get().refresh();
  };

  return {
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
    stage: (path) => mutate(() => gitStage(path)),
    unstage: (path) => mutate(() => gitUnstage(path)),
    stageAll: () => mutate(() => gitStageAll()),
    unstageAll: () => mutate(() => gitUnstageAll()),
  };
});
