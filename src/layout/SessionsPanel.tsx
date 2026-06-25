/*
 * Sessions panel + Timeline Rail (spec 4.2 — the signature). Phase 3 (basic)
 * renders the workspace's real `claude` sessions, resolved on open from the
 * CLI's own transcripts (spec 3.2) and kept live by a backend FsWatcher. The
 * session the engine is currently driving pulses as the active head. Per-session
 * branch/checkpoint structure (full `/rewind` rail) is Phase 7.
 */

import { useEffect, type ReactNode } from "react";
import { useSessions } from "@/store/sessions";
import { useConversation } from "@/store/conversation";
import { useActiveCwd } from "@/store/workspaces";
import type { SessionMeta } from "@/ipc/types";

export function SessionsPanel() {
  const cwd = useActiveCwd();
  const slice = useSessions((s) => (cwd ? s.byCwd[cwd] : undefined));
  const sessions = slice?.sessions ?? [];
  const loaded = slice?.loaded ?? false;
  const error = slice?.error ?? null;
  const init = useSessions((s) => s.init);
  const activeId = useConversation((s) => s.sessionId);
  const streaming = useConversation((s) => s.streaming);
  const resume = useConversation((s) => s.resume);
  const newSession = useConversation((s) => s.newSession);

  useEffect(() => {
    if (cwd) void init(cwd);
  }, [cwd, init]);

  return (
    <aside
      className="flex h-full flex-col"
      style={{ background: "var(--color-bg-raised)" }}
    >
      <PanelHeader
        label="SESSIONS"
        action={
          <button
            type="button"
            onClick={() => newSession()}
            disabled={streaming}
            title="Start a new session"
            aria-label="Start a new session"
            className="cursor-pointer"
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              letterSpacing: "0.04em",
              color: streaming ? "var(--color-fg-muted)" : "var(--color-fg-secondary)",
              cursor: streaming ? "default" : "pointer",
            }}
          >
            + NEW
          </button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto" style={{ padding: "var(--space-4)" }}>
        {error ? (
          <StateNote text={error} tone="error" />
        ) : !loaded ? (
          <StateNote text="Loading sessions…" />
        ) : sessions.length === 0 ? (
          <StateNote text="No sessions yet — start a turn to begin one." />
        ) : (
          <ol className="flex flex-col">
            {sessions.map((session, i) => (
              <RailItem
                key={session.id}
                session={session}
                active={session.id === activeId}
                last={i === sessions.length - 1}
                disabled={streaming}
                onResume={() => void resume(session.id)}
                onFork={() => void resume(session.id, true)}
              />
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}

function RailItem({
  session,
  active,
  last,
  disabled,
  onResume,
  onFork,
}: {
  session: SessionMeta;
  active: boolean;
  last: boolean;
  disabled: boolean;
  onResume: () => void;
  onFork: () => void;
}) {
  const dotColor = active ? "var(--color-status-running)" : "var(--color-fg-secondary)";
  const meta = [session.gitBranch, relativeTime(session.lastActiveMs)]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className="group/rail flex gap-[var(--space-4)]" style={{ minHeight: "var(--space-8)" }}>
      {/* Rail column: node dot + connector line */}
      <div className="relative flex w-[14px] shrink-0 flex-col items-center">
        <span
          className={active ? "status-lamp-pulse" : undefined}
          style={{
            width: "10px",
            height: "10px",
            marginTop: "2px",
            borderRadius: "50%",
            background: dotColor,
            zIndex: 1,
          }}
          aria-hidden="true"
        />
        {!last && (
          <span
            style={{
              flex: 1,
              width: "2px",
              marginTop: "2px",
              background: "var(--color-border-strong)",
            }}
            aria-hidden="true"
          />
        )}
      </div>
      {/* Node content: the row resumes; fork is a hover/focus affordance. */}
      <div
        className="relative flex min-w-0 flex-1 items-start gap-[var(--space-2)]"
        style={{ paddingBottom: "var(--space-5)" }}
      >
        <button
          type="button"
          onClick={onResume}
          disabled={disabled}
          title={active ? `${session.label} (active)` : `Resume: ${session.label}`}
          aria-label={
            active ? `Active session: ${session.label}` : `Resume session: ${session.label}`
          }
          className="min-w-0 flex-1 text-left"
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: disabled ? "default" : "pointer",
            opacity: disabled && !active ? 0.5 : 1,
          }}
        >
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: active ? "var(--color-fg-primary)" : "var(--color-fg-secondary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {session.label}
          </div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: active ? "var(--color-status-running)" : "var(--color-fg-muted)",
            }}
          >
            {active ? `${meta || "active"} · active` : meta}
          </div>
        </button>
        {!active && (
          <button
            type="button"
            onClick={onFork}
            disabled={disabled}
            title={`Fork into a new branch: ${session.label}`}
            aria-label={`Fork session into a new branch: ${session.label}`}
            className="shrink-0 opacity-0 transition-opacity focus:opacity-100 group-hover/rail:opacity-100"
            style={{
              background: "transparent",
              border: "none",
              padding: "0 var(--space-1)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-sm)",
              color: "var(--color-fg-muted)",
              cursor: disabled ? "default" : "pointer",
            }}
          >
            ⑂
          </button>
        )}
      </div>
    </li>
  );
}

function StateNote({ text, tone }: { text: string; tone?: "error" }) {
  return (
    <p
      style={{
        fontSize: "var(--text-sm)",
        color: tone === "error" ? "var(--color-status-danger)" : "var(--color-fg-muted)",
        lineHeight: 1.5,
      }}
    >
      {text}
    </p>
  );
}

/** Compact relative time for the rail meta line. */
function relativeTime(ms: number): string {
  if (!ms) return "";
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function PanelHeader({ label, action }: { label: string; action?: ReactNode }) {
  return (
    <div
      className="flex shrink-0 items-center justify-between"
      style={{
        height: "var(--space-7)",
        padding: "0 var(--space-4)",
        borderBottom: "1px solid var(--color-border-subtle)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        letterSpacing: "0.04em",
        color: "var(--color-fg-secondary)",
      }}
    >
      <span>{label}</span>
      {action}
    </div>
  );
}
