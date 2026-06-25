/*
 * Sessions store (spec 3.2). Read-only mirror of the CLI's own session set,
 * keyed by workspace cwd so each open workspace keeps its own live list: loaded
 * on first focus (no forced turn) and then kept in sync via a backend FsWatcher,
 * so a freshly-created session appears live. Switching workspaces is instant —
 * the rail reads the active cwd's slice, never the previous workspace's.
 */

import { create } from "zustand";
import { listSessions, watchSessions } from "@/ipc/commands";
import type { SessionMeta } from "@/ipc/types";
import { isIpcError } from "@/ipc/types";

/** One workspace's session list + its load state. */
export interface SessionsSlice {
  sessions: SessionMeta[];
  loaded: boolean;
  error: string | null;
}

interface SessionsState {
  byCwd: Record<string, SessionsSlice>;
  /** Load + start watching a workspace's sessions. Idempotent per cwd (safe
   *  under StrictMode remounts and repeated focus). */
  init: (cwd: string) => Promise<void>;
}

// Module-local guard: list + watch run exactly once per workspace cwd (not once
// per StrictMode mount, which would open a duplicate watcher). Bounded by the
// number of workspaces opened this run.
const watching = new Set<string>();

export const useSessions = create<SessionsState>((set) => ({
  byCwd: {},

  init: async (cwd) => {
    if (watching.has(cwd)) return;
    watching.add(cwd);
    try {
      const sessions = await listSessions(cwd);
      set((s) => ({ byCwd: { ...s.byCwd, [cwd]: { sessions, loaded: true, error: null } } }));
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
}));
