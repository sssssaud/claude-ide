/*
 * Dev-only perf readout (spec 2.7). Surfaces the two Phase 0 budgets —
 * cold-start time and idle RSS — sampled live from the backend. Mono voice
 * (the identity face). Budget colors: within budget = success, over = awaiting.
 * Rendered only in dev (`import.meta.env.DEV`); never ships in the release UI.
 */

import { useEffect, useState } from "react";
import { perfStats } from "@/ipc/commands";
import type { PerfStats } from "@/ipc/types";

const COLD_START_BUDGET_MS = 1500; // spec 2.7
const RSS_BUDGET_MB = 250; // spec 2.7 (validate against WebKitGTK reality)

export function PerfBadge() {
  const [stats, setStats] = useState<PerfStats | null>(null);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let active = true;
    const sample = async () => {
      try {
        const s = await perfStats();
        if (active) setStats(s);
      } catch {
        /* perf readout is best-effort; never disrupt the app */
      }
    };
    void sample();
    const id = window.setInterval(sample, 2000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, []);

  if (!import.meta.env.DEV || !stats) return null;

  const coldOk =
    stats.coldStartMs !== null && stats.coldStartMs <= COLD_START_BUDGET_MS;
  const rssOk = stats.rssMb <= RSS_BUDGET_MB;

  return (
    <div
      className="pointer-events-none fixed bottom-[var(--space-3)] right-[var(--space-3)] z-50 flex gap-[var(--space-4)]"
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        padding: "var(--space-2) var(--space-4)",
        borderRadius: "var(--radius-md)",
        background: "var(--color-bg-overlay)",
        boxShadow: "var(--elev-2)",
        color: "var(--color-fg-secondary)",
      }}
      aria-hidden="true"
    >
      <span>
        cold{" "}
        <span
          style={{
            color: coldOk
              ? "var(--color-status-success)"
              : "var(--color-status-awaiting)",
          }}
        >
          {stats.coldStartMs === null ? "—" : `${stats.coldStartMs}ms`}
        </span>
      </span>
      <span>
        rss{" "}
        <span
          style={{
            color: rssOk
              ? "var(--color-status-success)"
              : "var(--color-status-awaiting)",
          }}
        >
          {stats.rssMb}MB
        </span>
      </span>
    </div>
  );
}
