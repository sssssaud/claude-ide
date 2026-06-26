/*
 * Active sessions + daemon status (Phase 9). A collapsible block at the top of
 * the Sessions rail that surfaces the CLI's own `claude agents --json` view —
 * every live `claude` session (this IDE's, a terminal's, a background agent's),
 * machine-wide — plus the transient daemon's status. Read-only: as a wrapper we
 * never manage agents ourselves; the CLI owns that. Lazy (loads on first expand)
 * with a manual refresh — no polling, so it never spawns `claude` on a timer.
 */

import { useCallback, useEffect, useState } from "react";
import { daemonStatus, listAgents } from "@/ipc/commands";
import { isIpcError, type AgentSession, type DaemonStatus } from "@/ipc/types";

export function AgentsSection({ currentSessionId }: { currentSessionId: string | null }) {
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<AgentSession[] | null>(null);
  const [daemon, setDaemon] = useState<DaemonStatus | null>(null);
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    let alive = true;
    Promise.all([listAgents(includeCompleted), daemonStatus()])
      .then(([a, d]) => {
        if (!alive) return;
        setAgents(a);
        setDaemon(d);
      })
      .catch((e) => alive && setError(isIpcError(e) ? e.message : "Could not load active sessions"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [includeCompleted]);

  // (Re)load when opened or when the completed-toggle flips while open.
  useEffect(() => {
    if (open) return load();
  }, [open, load]);

  const count = agents?.length ?? 0;

  return (
    <div
      style={{
        marginBottom: "var(--space-3)",
        paddingBottom: "var(--space-3)",
        borderBottom: "1px solid var(--color-border-subtle)",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-[var(--space-2)]"
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          letterSpacing: "0.04em",
          color: "var(--color-fg-secondary)",
        }}
      >
        <span>{open ? "▾" : "▸"} ACTIVE SESSIONS</span>
        {agents && <span style={{ color: "var(--color-fg-muted)" }}>({count})</span>}
        <span
          aria-hidden="true"
          title={daemon?.running ? "Daemon running" : "Daemon idle"}
          style={{
            marginLeft: "auto",
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            background: daemon?.running ? "var(--color-status-running)" : "var(--color-fg-muted)",
            opacity: daemon ? 1 : 0.4,
          }}
        />
      </button>

      {open && (
        <div style={{ marginTop: "var(--space-2)" }}>
          {/* Daemon line */}
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--color-fg-muted)",
              marginBottom: "var(--space-2)",
            }}
          >
            {daemon
              ? daemon.running
                ? `Daemon: running · ${daemon.workerCount} worker${daemon.workerCount === 1 ? "" : "s"}`
                : "Daemon: idle · starts on demand"
              : "Daemon: …"}
          </div>

          {/* Controls */}
          <div className="flex items-center gap-[var(--space-3)]" style={{ marginBottom: "var(--space-2)" }}>
            <button
              type="button"
              onClick={() => load()}
              disabled={loading}
              className={loading ? "" : "cursor-pointer"}
              style={{
                border: "none",
                background: "transparent",
                color: "var(--color-fg-secondary)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                padding: 0,
              }}
            >
              {loading ? "…" : "↻ refresh"}
            </button>
            <label
              className="flex cursor-pointer items-center gap-[var(--space-1)]"
              style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--color-fg-muted)" }}
            >
              <input
                type="checkbox"
                checked={includeCompleted}
                onChange={(e) => setIncludeCompleted(e.target.checked)}
              />
              completed
            </label>
          </div>

          {error ? (
            <Note text={error} tone="error" />
          ) : !agents ? (
            <Note text="Loading…" />
          ) : count === 0 ? (
            <Note text="No active sessions." />
          ) : (
            <ul className="flex flex-col gap-[var(--space-1)]">
              {agents.map((a, i) => (
                <AgentRow key={a.sessionId ?? a.pid ?? i} agent={a} isCurrent={!!a.sessionId && a.sessionId === currentSessionId} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function AgentRow({ agent, isCurrent }: { agent: AgentSession; isCurrent: boolean }) {
  const status = (agent.status ?? "").toLowerCase();
  const statusColor =
    status === "busy"
      ? "var(--color-status-running)"
      : status === "idle"
        ? "var(--color-fg-secondary)"
        : "var(--color-fg-muted)";
  const meta = [agent.kind, agent.pid != null ? `pid ${agent.pid}` : null, relativeTime(agent.startedAt)]
    .filter(Boolean)
    .join(" · ");

  return (
    <li
      title={agent.cwd ?? undefined}
      style={{
        padding: "var(--space-1) var(--space-2)",
        borderRadius: "var(--radius-sm)",
        background: isCurrent ? "var(--color-accent-quiet)" : "var(--color-bg-base)",
        borderLeft: `2px solid ${statusColor}`,
      }}
    >
      <div className="flex items-center gap-[var(--space-2)]">
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: "var(--text-xs)",
            color: "var(--color-fg-secondary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {agent.cwd ? basename(agent.cwd) : "—"}
          {isCurrent && (
            <span style={{ marginLeft: "var(--space-1)", color: "var(--color-accent)" }}>· this</span>
          )}
        </span>
        <span
          style={{
            flexShrink: 0,
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: statusColor,
          }}
        >
          {agent.status ?? "?"}
        </span>
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color: "var(--color-fg-muted)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {meta}
      </div>
    </li>
  );
}

function Note({ text, tone }: { text: string; tone?: "error" }) {
  return (
    <p
      style={{
        fontSize: "var(--text-xs)",
        color: tone === "error" ? "var(--color-status-danger)" : "var(--color-fg-muted)",
        lineHeight: 1.5,
      }}
    >
      {text}
    </p>
  );
}

function basename(path: string): string {
  const cleaned = path.replace(/\/+$/, "");
  const i = cleaned.lastIndexOf("/");
  return i >= 0 ? cleaned.slice(i + 1) : cleaned;
}

function relativeTime(ms?: number): string {
  if (!ms) return "";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
