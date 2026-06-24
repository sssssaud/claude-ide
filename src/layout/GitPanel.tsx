/*
 * Source Control panel (spec 5.A.3, Phase 4). Read-only this slice: the current
 * branch (+ ahead/behind), a Refresh, and the working-tree changes grouped like
 * VS Code — Merge Changes (conflicts), Staged Changes, Changes. Clicking a row
 * opens that file's diff in a read-only diff tab. Stage / unstage / commit and
 * guarded discard arrive in the next slice.
 */

import { useEffect } from "react";
import { useGit } from "@/store/git";
import { useEditor } from "@/store/editor";
import type { GitChange } from "@/ipc/types";

export function GitPanel() {
  const status = useGit((s) => s.status);
  const loading = useGit((s) => s.loading);
  const error = useGit((s) => s.error);
  const refresh = useGit((s) => s.refresh);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const changes = status?.changes ?? [];
  const conflicts = changes.filter((c) => c.status === "conflicted");
  const staged = changes.filter((c) => c.staged);
  const unstaged = changes.filter((c) => !c.staged && c.status !== "conflicted");
  const clean = status?.isRepo && changes.length === 0;

  return (
    <div className="flex h-full flex-col">
      <Header
        branch={status?.branch ?? null}
        ahead={status?.ahead ?? 0}
        behind={status?.behind ?? 0}
        busy={loading}
        onRefresh={() => void refresh()}
      />
      <div className="min-h-0 flex-1 overflow-y-auto" style={{ padding: "var(--space-2) 0" }}>
        {error ? (
          <Note text={error} tone="error" />
        ) : !status ? (
          <Note text="Loading…" />
        ) : !status.isRepo ? (
          <Note text="Not a git repository." />
        ) : clean ? (
          <Note text="No changes — working tree clean." />
        ) : (
          <>
            <Group title="Merge changes" items={conflicts} />
            <Group title="Staged changes" items={staged} />
            <Group title="Changes" items={unstaged} />
          </>
        )}
      </div>
    </div>
  );
}

function Group({ title, items }: { title: string; items: GitChange[] }) {
  if (items.length === 0) return null;
  return (
    <section style={{ marginBottom: "var(--space-2)" }}>
      <div
        className="flex items-center justify-between"
        style={{
          padding: "var(--space-1) var(--space-4)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          letterSpacing: "0.04em",
          color: "var(--color-fg-secondary)",
        }}
      >
        <span>{title.toUpperCase()}</span>
        <span style={{ color: "var(--color-fg-muted)" }}>{items.length}</span>
      </div>
      {items.map((c) => (
        <ChangeRow key={`${c.staged ? "s" : "w"}:${c.path}`} change={c} />
      ))}
    </section>
  );
}

function ChangeRow({ change }: { change: GitChange }) {
  const openDiff = useEditor((s) => s.openDiff);
  const activePath = useEditor((s) => s.activePath);
  const id = `diff:${change.staged ? "staged" : "working"}:${change.path}`;
  const active = activePath === id;

  const dir = change.path.includes("/") ? change.path.slice(0, change.path.lastIndexOf("/")) : "";
  const name = change.path.slice(change.path.lastIndexOf("/") + 1);
  const { letter, color } = badge(change.status);

  return (
    <button
      type="button"
      onClick={() => openDiff(change.path, change.staged)}
      title={`${change.path} — ${change.status}`}
      className="flex w-full cursor-pointer items-center gap-[var(--space-2)]"
      style={{
        border: "none",
        background: active ? "var(--color-accent-quiet)" : "transparent",
        padding: "3px var(--space-4)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        textAlign: "left",
      }}
    >
      <span
        className="shrink-0"
        style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}
      >
        <span style={{ color: active ? "var(--color-fg-primary)" : "var(--color-fg-secondary)" }}>
          {name}
        </span>
        {dir && <span style={{ marginLeft: "var(--space-2)", color: "var(--color-fg-muted)" }}>{dir}</span>}
      </span>
      <span
        aria-hidden="true"
        className="ml-auto shrink-0"
        style={{ color, width: "1em", textAlign: "center", fontWeight: 600 }}
      >
        {letter}
      </span>
    </button>
  );
}

/** Single-letter status badge + token color, VS Code-style. */
function badge(status: string): { letter: string; color: string } {
  switch (status) {
    case "added":
      return { letter: "A", color: "var(--color-status-success)" };
    case "untracked":
      return { letter: "U", color: "var(--color-status-success)" };
    case "deleted":
      return { letter: "D", color: "var(--color-status-danger)" };
    case "renamed":
      return { letter: "R", color: "var(--color-status-info)" };
    case "copied":
      return { letter: "C", color: "var(--color-status-info)" };
    case "typechange":
      return { letter: "T", color: "var(--color-status-info)" };
    case "conflicted":
      return { letter: "!", color: "var(--color-status-danger)" };
    default:
      return { letter: "M", color: "var(--color-status-info)" };
  }
}

function Header({
  branch,
  ahead,
  behind,
  busy,
  onRefresh,
}: {
  branch: string | null;
  ahead: number;
  behind: number;
  busy: boolean;
  onRefresh: () => void;
}) {
  const sync = [behind ? `↓${behind}` : "", ahead ? `↑${ahead}` : ""].filter(Boolean).join(" ");
  return (
    <div
      className="flex shrink-0 items-center justify-between gap-[var(--space-2)]"
      style={{
        height: "var(--space-7)",
        padding: "0 var(--space-3) 0 var(--space-4)",
        borderBottom: "1px solid var(--color-border-subtle)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        color: "var(--color-fg-secondary)",
      }}
    >
      <span
        className="flex items-center gap-[var(--space-2)]"
        style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        <span aria-hidden="true">⎇</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{branch ?? "—"}</span>
        {sync && <span style={{ color: "var(--color-fg-muted)" }}>{sync}</span>}
      </span>
      <button
        type="button"
        onClick={onRefresh}
        disabled={busy}
        title="Refresh"
        aria-label="Refresh source control"
        className={busy ? undefined : "cursor-pointer"}
        style={{
          border: "none",
          background: "transparent",
          color: "var(--color-fg-secondary)",
          opacity: busy ? 0.5 : 1,
        }}
      >
        ↻
      </button>
    </div>
  );
}

function Note({ text, tone }: { text: string; tone?: "error" }) {
  return (
    <p
      style={{
        padding: "var(--space-2) var(--space-4)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        color: tone === "error" ? "var(--color-status-danger)" : "var(--color-fg-muted)",
        lineHeight: 1.5,
      }}
    >
      {text}
    </p>
  );
}
