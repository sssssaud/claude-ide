/*
 * Git store (spec 5.A.3, Phase 4). Holds the workspace's source-control status
 * for the Source Control panel and exposes the non-destructive mutations
 * (stage / unstage), each of which refreshes the status afterward. Commit lives
 * in the panel (it needs a message + success feedback). Live fs-watching is a
 * later refinement; destructive ops (discard) are a later, confirm-gated slice.
 */

import { create } from "zustand";
import {
  gitBranches,
  gitCreateBranch,
  gitStage,
  gitStageAll,
  gitStatus,
  gitSwitchBranch,
  gitUnstage,
  gitUnstageAll,
} from "@/ipc/commands";
import { isIpcError, type GitBranches, type GitStatus } from "@/ipc/types";

interface GitState {
  status: GitStatus | null;
  branches: GitBranches | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  loadBranches: () => Promise<void>;
  stage: (path: string) => Promise<void>;
  unstage: (path: string) => Promise<void>;
  stageAll: () => Promise<void>;
  unstageAll: () => Promise<void>;
  switchBranch: (name: string) => Promise<void>;
  createBranch: (name: string) => Promise<void>;
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

  // A branch op also moves HEAD, so refresh the branch list alongside status.
  const mutateBranch = async (op: () => Promise<unknown>) => {
    await mutate(op);
    await get().loadBranches();
  };

  return {
    status: null,
    branches: null,
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
    loadBranches: async () => {
      try {
        set({ branches: await gitBranches() });
      } catch (e) {
        set({ error: isIpcError(e) ? e.message : "Could not read branches" });
      }
    },
    stage: (path) => mutate(() => gitStage(path)),
    unstage: (path) => mutate(() => gitUnstage(path)),
    stageAll: () => mutate(() => gitStageAll()),
    unstageAll: () => mutate(() => gitUnstageAll()),
    switchBranch: (name) => mutateBranch(() => gitSwitchBranch(name)),
    createBranch: (name) => mutateBranch(() => gitCreateBranch(name)),
  };
});
