/*
 * Sessions store (spec 3.2). Read-only mirror of the CLI's own session set,
 * keyed by workspace cwd so each open workspace keeps its own live list: loaded
 * on first focus (no forced turn) and then kept in sync via a backend FsWatcher,
 * so a freshly-created session appears live. Switching workspaces is instant —
 * the rail reads the active cwd's slice, never the previous workspace's.
 */

import { create } from "zustand";
import {
  detectMovedSessions,
  listSessions,
  relinkMovedSessions,
  watchSessions,
} from "@/ipc/commands";
import type { MovedProject, SessionMeta } from "@/ipc/types";
import { isIpcError } from "@/ipc/types";

/** One workspace's session list + its load state. */
export interface SessionsSlice {
  sessions: SessionMeta[];
  loaded: boolean;
  error: string | null;
}

interface SessionsState {
  byCwd: Record<string, SessionsSlice>;
  /** Per-cwd: prior locations of this folder that still hold unrestored sessions. */
  movedByCwd: Record<string, MovedProject[]>;
  /** Load + start watching a workspace's sessions. Idempotent per cwd (safe
   *  under StrictMode remounts and repeated focus). */
  init: (cwd: string) => Promise<void>;
  /** Re-scan for moved sessions (on open, and after a restore). */
  detectMoved: (cwd: string) => Promise<void>;
  /** Copy a moved project's sessions into this location, then refresh. Throws on
   *  failure so the caller can surface it. */
  relink: (cwd: string, slug: string) => Promise<void>;
}

// Module-local guard: list + watch run exactly once per workspace cwd (not once
// per StrictMode mount, which would open a duplicate watcher). Bounded by the
// number of workspaces opened this run.
const watching = new Set<string>();

export const useSessions = create<SessionsState>((set, get) => ({
  byCwd: {},
  movedByCwd: {},

  init: async (cwd) => {
    if (watching.has(cwd)) return;
    watching.add(cwd);
    try {
      const sessions = await listSessions(cwd);
      set((s) => ({ byCwd: { ...s.byCwd, [cwd]: { sessions, loaded: true, error: null } } }));
      void get().detectMoved(cwd);
      // Push refreshed lists straight into this cwd's slice as sessions change.
      await watchSessions(
        (next) =>
          set((s) => ({ byCwd: { ...s.byCwd, [cwd]: { sessions: next, loaded: true, error: null } } })),
        cwd,
      );
    } catch (e) {
      watching.delete(cwd); // allow a later retry
      set((s) => ({
        byCwd: {
          ...s.byCwd,
          [cwd]: {
            sessions: [],
            loaded: true,
            error: isIpcError(e) ? e.message : "Failed to load sessions",
          },
        },
      }));
    }
  },

  detectMoved: async (cwd) => {
    try {
      const moved = await detectMovedSessions(cwd);
      set((s) => ({ movedByCwd: { ...s.movedByCwd, [cwd]: moved } }));
    } catch {
      // Non-critical: a detection failure just means no restore prompt.
      set((s) => ({ movedByCwd: { ...s.movedByCwd, [cwd]: [] } }));
    }
  },

  relink: async (cwd, slug) => {
    await relinkMovedSessions(slug, cwd);
    // The fs-watcher refreshes the list from the copied files; re-scan so the
    // prompt clears once everything is present here.
    await get().detectMoved(cwd);
  },
}));
