/*
 * Root component. On first paint it (1) reports ready to anchor the cold-start
 * budget, and (2) runs the environment preflight gate. On success the workspace
 * shell renders; otherwise a guided fix (spec 3.10, 4.6).
 */

import { useEffect } from "react";
import { useAppStore } from "@/store/app";
import { reportReady } from "@/ipc/commands";
import { PreflightGate } from "@/components/Preflight";
import { WorkspaceShell } from "@/layout/WorkspaceShell";
import { PerfBadge } from "@/components/PerfBadge";

function App() {
  const phase = useAppStore((s) => s.preflightPhase);
  const runPreflight = useAppStore((s) => s.runPreflight);

  useEffect(() => {
    // Anchor the cold-start metric as soon as the UI paints (spec 2.7).
    void reportReady();
    // Gate on the installed CLI before offering to spawn anything.
    void runPreflight();
  }, [runPreflight]);

  return (
    <>
      {phase === "ready" ? <WorkspaceShell /> : <PreflightGate />}
      <PerfBadge />
    </>
  );
}

export default App;
