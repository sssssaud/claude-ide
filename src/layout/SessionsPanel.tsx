/*
 * Sessions panel + Timeline Rail (spec 4.2 — the signature). Phase 3 (basic)
 * renders the workspace's real `claude` sessions, resolved on open from the
 * CLI's own transcripts (spec 3.2) and kept live by a backend FsWatcher. The
 * session the engine is currently driving pulses as the active head. Per-session
 * branch/checkpoint structure (full `/rewind` rail) is Phase 7.
 */

import { useEffect, useState, type ReactNode } from "react";
import { AgentsSection } from "@/layout/AgentsSection";
import { InlineTerminal } from "@/components/InlineTerminal";
import { shellQuote } from "@/lib/shell";
import { useSessions } from "@/store/sessions";
import { useActiveConversation } from "@/store/conversation";
import { activeEditorStore } from "@/store/editor";
import { useLayout } from "@/store/layout";
import { useActiveCwd } from "@/store/workspaces";
import { checkpointTimeline } from "@/ipc/commands";
import {
  isIpcError,
  type CheckpointEntry,
  type MovedProject,
  type SessionMeta,
} from "@/ipc/types";

/** Stable empty reference so the store selector doesn't churn renders. */
const NO_MOVED: MovedProject[] = [];

export function SessionsPanel() {
  const cwd = useActiveCwd();
  const slice = useSessions((s) => (cwd ? s.byCwd[cwd] : undefined));
  const sessions = slice?.sessions ?? [];
  const loaded = slice?.loaded ?? false;
  const error = slice?.error ?? null;
  const activeId = useActiveConversation((s) => s.sessionId);
  const streaming = useActiveConversation((s) => s.streaming);
  const resume = useActiveConversation((s) => s.resume);
  const newSession = useActiveConversation((s) => s.newSession);
  const moved = useSessions((s) => (cwd ? s.movedByCwd[cwd] ?? NO_MOVED : NO_MOVED));
  const relink = useSessions((s) => s.relink);
  // The session-load + auto-continue effects live in `useSessionBootstrap`
  // (mounted in the shell), so they run even when this view isn't open.

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
        {cwd && moved.length > 0 && (
          <MovedBanner cwd={cwd} groups={moved} onRestore={relink} />
        )}
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
        {loaded && !error && cwd && sessions.length > 0 && (
          <CleanupSection cwd={cwd} disabled={streaming} />
        )}
      </div>
    </aside>
  );
}

/** Restore prompt shown when this folder was moved/renamed and its earlier
 *  location still holds sessions. Reading them already works (the rail resolves a
 *  single moved match); Restore copies the CLI's transcripts into the new
 *  location so `--resume` works too. Copy-only — nothing is deleted. */
function MovedBanner({
  cwd,
  groups,
  onRestore,
}: {
  cwd: string;
  groups: MovedProject[];
  onRestore: (cwd: string, slug: string) => Promise<void>;
}) {
  return (
    <div
      role="status"
      style={{
        marginBottom: "var(--space-4)",
        padding: "var(--space-3)",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--color-border-strong)",
        background: "var(--color-bg-raised)",
      }}
    >
      <div
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--color-fg-primary)",
          marginBottom: "var(--space-2)",
          lineHeight: 1.4,
        }}
      >
        Sessions from a previous location of this folder. Restore to resume them here.
      </div>
      <div className="flex flex-col gap-[var(--space-3)]">
        {groups.map((g) => (
          <MovedRow key={g.slug} cwd={cwd} group={g} onRestore={onRestore} />
        ))}
      </div>
    </div>
  );
}

function MovedRow({
  cwd,
  group,
  onRestore,
}: {
  cwd: string;
  group: MovedProject;
  onRestore: (cwd: string, slug: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = group.sessionCount;

  const restore = async () => {
    setBusy(true);
    setError(null);
    try {
      await onRestore(cwd, group.slug);
      // On success this group is re-detected away, so the row unmounts.
    } catch (e) {
      setError(isIpcError(e) ? e.message : "Could not restore sessions");
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-[var(--space-1)]">
      <div
        title={group.oldCwd}
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color: "var(--color-fg-muted)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {group.oldCwd}
      </div>
      <div className="flex items-center gap-[var(--space-2)]">
        <button
          type="button"
          onClick={() => void restore()}
          disabled={busy}
          aria-label={`Restore ${count} session${count === 1 ? "" : "s"} from ${group.oldCwd}`}
          className="cursor-pointer"
          style={{
            background: "transparent",
            border: "1px solid var(--color-border-strong)",
            borderRadius: "var(--radius-sm)",
            padding: "2px var(--space-2)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: busy ? "var(--color-fg-muted)" : "var(--color-fg-secondary)",
            cursor: busy ? "default" : "pointer",
          }}
        >
          {busy ? "Restoring…" : `Restore ${count} session${count === 1 ? "" : "s"}`}
        </button>
      </div>
      {error && <StateNote text={error} tone="error" />}
    </div>
  );
}

/** "Clean up sessions…" — hosts the CLI's own `claude project purge -i` in an
 *  inline terminal (Addendum III S17). The CLI prompts before every deletion;
 *  the app adds zero deletion logic of its own (wrapper contract: state under
 *  `~/.claude` is only ever removed by the CLI). The rail's file-watcher picks
 *  up whatever the purge removed, so the list refreshes itself. */
function CleanupSection({ cwd, disabled }: { cwd: string; disabled: boolean }) {
  const [running, setRunning] = useState(false);

  return (
    <div
      style={{
        marginTop: "var(--space-5)",
        paddingTop: "var(--space-3)",
        borderTop: "1px solid var(--color-border-subtle)",
      }}
    >
      {running ? (
        <>
          <StateNote text="The CLI asks before each deletion — nothing is removed without your yes. The session you're in right now is listed too; answer No to keep it. Ctrl-C aborts." />
          <div style={{ marginTop: "var(--space-2)" }}>
            <InlineTerminal
              key="session-cleanup"
              ariaLabel="Session cleanup terminal"
              command={`claude project purge -i ${shellQuote(cwd)}`}
              onExit={() => setRunning(false)}
            />
          </div>
          <button
            type="button"
            onClick={() => setRunning(false)}
            className="cursor-pointer"
            style={{
              marginTop: "var(--space-2)",
              background: "transparent",
              border: "none",
              padding: 0,
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--color-fg-secondary)",
            }}
          >
            Close
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setRunning(true)}
          disabled={disabled}
          title="Delete sessions for this project via the CLI's own purge flow (asks per item)"
          aria-label="Clean up sessions for this project"
          className="cursor-pointer"
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            letterSpacing: "0.04em",
            color: disabled ? "var(--color-fg-muted)" : "var(--color-fg-secondary)",
            cursor: disabled ? "default" : "pointer",
          }}
        >
          CLEAN UP SESSIONS…
        </button>
      )}
    </div>
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
          className={active && disabled ? "status-lamp-pulse" : undefined}
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
