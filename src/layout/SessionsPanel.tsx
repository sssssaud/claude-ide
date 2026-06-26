/*
 * Sessions panel + Timeline Rail (spec 4.2 — the signature). Phase 3 (basic)
 * renders the workspace's real `claude` sessions, resolved on open from the
 * CLI's own transcripts (spec 3.2) and kept live by a backend FsWatcher. The
 * session the engine is currently driving pulses as the active head. Per-session
 * branch/checkpoint structure (full `/rewind` rail) is Phase 7.
 */

import { useEffect, useState, type ReactNode } from "react";
import { AgentsSection } from "@/layout/AgentsSection";
import { useSessions } from "@/store/sessions";
import { useActiveConversation } from "@/store/conversation";
import { activeEditorStore } from "@/store/editor";
import { useLayout } from "@/store/layout";
import { useActiveCwd } from "@/store/workspaces";
import { checkpointTimeline } from "@/ipc/commands";
import { isIpcError, type CheckpointEntry, type SessionMeta } from "@/ipc/types";

export function SessionsPanel() {
  const cwd = useActiveCwd();
  const slice = useSessions((s) => (cwd ? s.byCwd[cwd] : undefined));
  const sessions = slice?.sessions ?? [];
  const loaded = slice?.loaded ?? false;
  const error = slice?.error ?? null;
  const init = useSessions((s) => s.init);
  const activeId = useActiveConversation((s) => s.sessionId);
  const streaming = useActiveConversation((s) => s.streaming);
  const resume = useActiveConversation((s) => s.resume);
  const newSession = useActiveConversation((s) => s.newSession);
  const maybeContinue = useActiveConversation((s) => s.maybeContinue);

  useEffect(() => {
    if (cwd) void init(cwd);
  }, [cwd, init]);

  // `claude -c` behaviour: once this workspace's sessions are known, continue
  // the most recent one (sessions are newest-first). One-shot in the store, so
  // this re-fires harmlessly on watcher updates and tab switches.
  useEffect(() => {
    if (loaded && sessions.length > 0) maybeContinue(sessions[0].id);
  }, [loaded, sessions, maybeContinue]);

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
        <AgentsSection currentSessionId={activeId} />
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
                cwd={cwd ?? undefined}
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
  cwd,
  active,
  last,
  disabled,
  onResume,
  onFork,
}: {
  session: SessionMeta;
  cwd?: string;
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
      {/* Node content: the row resumes; fork is a hover/focus affordance; the
          checkpoints expander reveals this session's read-only edit timeline. */}
      <div
        className="relative flex min-w-0 flex-1 flex-col"
        style={{ paddingBottom: "var(--space-5)" }}
      >
        <div className="flex min-w-0 items-start gap-[var(--space-2)]">
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
        <CheckpointSection sessionId={session.id} cwd={cwd} />
      </div>
    </li>
  );
}

/** Per-session, lazily-loaded read-only checkpoint timeline (Phase 7 P2). The
 *  edit history is fetched on first expand; clicking an entry opens its
 *  snapshot-vs-current diff in the editor. No restore (the CLI has no API). */
function CheckpointSection({ sessionId, cwd }: { sessionId: string; cwd?: string }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<CheckpointEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || entries || error) return;
    let alive = true;
    checkpointTimeline(sessionId, cwd)
      .then((t) => alive && setEntries(t.entries))
      .catch((e) => alive && setError(isIpcError(e) ? e.message : "Could not load checkpoints"));
    return () => {
      alive = false;
    };
  }, [open, entries, error, sessionId, cwd]);

  const openDiff = (entry: CheckpointEntry) => {
    useLayout.getState().setVisible("editor", true);
    activeEditorStore().getState().openCheckpointDiff(entry.path, sessionId, entry.version);
  };

  const count = entries?.length ?? 0;
  return (
    <div style={{ marginTop: "var(--space-1)" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="cursor-pointer"
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color: "var(--color-fg-muted)",
        }}
      >
        {open ? "▾" : "▸"} checkpoints{entries ? ` (${count})` : ""}
      </button>
      {open && (
        <div style={{ marginTop: "var(--space-1)" }}>
          {error ? (
            <StateNote text={error} tone="error" />
          ) : !entries ? (
            <StateNote text="Loading…" />
          ) : count === 0 ? (
            <StateNote text="No file edits recorded for this session." />
          ) : (
            <ul className="flex flex-col gap-[2px]">
              {entries.slice(0, 60).map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => openDiff(entry)}
                    title={`${entry.path} @v${entry.version} — ${entry.tool}; view snapshot vs current`}
                    className="flex w-full min-w-0 cursor-pointer items-baseline gap-[var(--space-2)] text-left"
                    style={{
                      background: "transparent",
                      border: "none",
                      padding: "1px var(--space-1)",
                      borderRadius: "var(--radius-sm)",
                    }}
                  >
                    <span
                      style={{
                        minWidth: 0,
                        flex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: "var(--text-xs)",
                        color: "var(--color-fg-secondary)",
                      }}
                    >
                      {entry.path}
                    </span>
                    <span
                      style={{
                        flexShrink: 0,
                        fontFamily: "var(--font-mono)",
                        fontSize: "var(--text-xs)",
                        color: "var(--color-fg-muted)",
                      }}
                    >
                      v{entry.version} · {relativeTime(entry.timestampMs)}
                    </span>
                  </button>
                </li>
              ))}
              {count > 60 && (
                <li>
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--color-fg-muted)" }}>
                    +{count - 60} older…
                  </span>
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
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
