/*
 * Sessions store (spec 3.2). Read-only mirror of the CLI's own session set for
 * the workspace: loads the list on open (no forced turn) and then keeps it in
 * sync via a backend FsWatcher, so a freshly-created session appears live.
 */

import { create } from "zustand";
import { listSessions, watchSessions } from "@/ipc/commands";
import type { SessionMeta } from "@/ipc/types";
import { isIpcError } from "@/ipc/types";

interface SessionsState {
  sessions: SessionMeta[];
  loaded: boolean;
  error: string | null;
  /** Load once and start watching. Idempotent (safe under StrictMode remounts). */
  init: () => Promise<void>;
}

// Module-local guard: the load + watch must run exactly once for the app, not
// once per StrictMode mount (which would open a second watcher).
let started = false;

export const useSessions = create<SessionsState>((set) => ({
  sessions: [],
  loaded: false,
  error: null,

  init: async () => {
    if (started) return;
    started = true;
    try {
      const sessions = await listSessions();
      set({ sessions, loaded: true, error: null });
      // Push refreshed lists straight into the store as sessions come and go.
      await watchSessions((next) => set({ sessions: next }));
    } catch (e) {
      started = false; // allow a later retry
      set({ loaded: true, error: isIpcError(e) ? e.message : "Failed to load sessions" });
    }
  },
}));
