/*
 * App store (spec 2.5). The frontend store is derived and read-only with
 * respect to backend truth — it mirrors what the backend reports and never
 * invents authoritative state. Phase 0 tracks the preflight gate; the
 * WorkspaceRegistry mirror arrives in Phase 1.
 */

import { create } from "zustand";
import { preflight } from "@/ipc/commands";
import type { IpcError, PreflightReport } from "@/ipc/types";
import { isIpcError } from "@/ipc/types";

/** Preflight gate phase, driving which top-level view renders. */
export type PreflightPhase = "checking" | "ready" | "blocked" | "error";

interface AppState {
  preflightPhase: PreflightPhase;
  report: PreflightReport | null;
  error: IpcError | null;
  /** Run the environment preflight and update the gate phase. */
  runPreflight: () => Promise<void>;
}

export const useAppStore = create<AppState>((set) => ({
  preflightPhase: "checking",
  report: null,
  error: null,

  runPreflight: async () => {
    set({ preflightPhase: "checking", error: null });
    try {
      const report = await preflight();
      set({
        report,
        preflightPhase: report.ok ? "ready" : "blocked",
      });
    } catch (e) {
      set({
        preflightPhase: "error",
        error: isIpcError(e)
          ? e
          : { kind: "internal", message: "Preflight failed unexpectedly" },
      });
    }
  },
}));
