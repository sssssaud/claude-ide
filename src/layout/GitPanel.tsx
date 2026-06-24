/*
 * Source Control panel (spec 5.A.3, Phase 4). Slice A + B: the current branch
 * (+ ahead/behind), a Refresh, a commit box, and the working-tree changes
 * grouped like VS Code — Merge Changes (conflicts), Staged Changes, Changes —
 * with per-row stage/unstage (＋ / －) and per-group stage-all/unstage-all.
 * Clicking a row opens that file's diff. All mutations here are non-destructive
 * (staging never loses work); discard lands in slice C behind a confirm.
 */

import { useEffect, useState } from "react";
import { gitCommit } from "@/ipc/commands";
import { isIpcError, type GitChange } from "@/ipc/types";
import { useEditor } from "@/store/editor";
import { useGit } from "@/store/git";

export function GitPanel() {
  const status = useGit((s) => s.status);
  const loading = useGit((s) => s.loading);
  const error = useGit((s) => s.error);
  const refresh = useGit((s) => s.refresh);
  const loadBranches = useGit((s) => s.loadBranches);
  const stageAll = useGit((s) => s.stageAll);
  const unstageAll = useGit((s) => s.unstageAll);

  useEffect(() => {
    void refresh();
    void loadBranches();
  }, [refresh, loadBranches]);

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
      {status?.isRepo && <CommitBox stagedCount={staged.length} />}
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
            <Group title="Staged changes" items={staged} action="unstage" onAction={() => void unstageAll()} />
            <Group title="Changes" items={unstaged} action="stage" onAction={() => void stageAll()} />
          </>
        )}
      </div>
    </div>
  );
}

function CommitBox({ stagedCount }: { stagedCount: number }) {
  const refresh = useGit((s) => s.refresh);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const canCommit = stagedCount > 0 && message.trim().length > 0 && !busy;

  const commit = async () => {
    if (!canCommit) return;
    setBusy(true);
    setFeedback(null);
    try {
      await gitCommit(message);
      setMessage("");
      setFeedback({ tone: "ok", text: "Committed." });
      await refresh();
    } catch (e) {
      setFeedback({ tone: "error", text: isIpcError(e) ? e.message : "Commit failed" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="flex shrink-0 flex-col gap-[var(--space-2)]"
      style={{
        padding: "var(--space-3) var(--space-4)",
        borderBottom: "1px solid var(--color-border-subtle)",
      }}
    >
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            void commit();
          }
        }}
        rows={2}
        placeholder={
          stagedCount > 0 ? "Message (Ctrl/Cmd-Enter to commit)" : "Stage changes to commit"
        }
        spellCheck={false}
        style={{
          resize: "none",
          width: "100%",
          padding: "var(--space-2)",
          background: "var(--color-bg-recessed)",
          border: "1px solid var(--color-border-subtle)",
          borderRadius: "var(--radius-sm)",
          color: "var(--color-fg-primary)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
        }}
      />
      <div className="flex items-center justify-between gap-[var(--space-2)]">
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: feedback?.tone === "error" ? "var(--color-status-danger)" : "var(--color-fg-muted)",
          }}
        >
          {feedback?.text ?? (stagedCount > 0 ? `${stagedCount} staged` : "")}
        </span>
        <button
          type="button"
          onClick={() => void commit()}
          disabled={!canCommit}
          title="Commit staged changes (Ctrl/Cmd-Enter)"
          className={canCommit ? "cursor-pointer" : undefined}
          style={{
            padding: "3px var(--space-3)",
            border: "1px solid var(--color-border-subtle)",
            borderRadius: "var(--radius-sm)",
            background: canCommit ? "var(--color-accent-quiet)" : "transparent",
            color: canCommit ? "var(--color-fg-primary)" : "var(--color-fg-muted)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            opacity: canCommit ? 1 : 0.6,
          }}
        >
          {busy ? "Committing…" : "✓ Commit"}
        </button>
      </div>
    </div>
  );
}

function Group({
  title,
  items,
  action,
  onAction,
}: {
  title: string;
  items: GitChange[];
  action?: "stage" | "unstage";
  onAction?: () => void;
}) {
  if (items.length === 0) return null;
  return (
    <section style={{ marginBottom: "var(--space-2)" }}>
      <div
        className="group/header flex items-center justify-between"
        style={{
          padding: "var(--space-1) var(--space-4)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          letterSpacing: "0.04em",
          color: "var(--color-fg-secondary)",
        }}
      >
        <span>{title.toUpperCase()}</span>
        <span className="flex items-center gap-[var(--space-2)]">
          {action && onAction && (
            <button
              type="button"
              onClick={onAction}
              title={action === "stage" ? "Stage all changes" : "Unstage all"}
              aria-label={action === "stage" ? "Stage all changes" : "Unstage all"}
              className="cursor-pointer opacity-0 group-hover/header:opacity-100"
              style={{
                border: "none",
                background: "transparent",
                color: "var(--color-fg-secondary)",
                fontSize: "var(--text-sm)",
                lineHeight: 1,
              }}
            >
              {action === "stage" ? "＋" : "－"}
            </button>
          )}
          <span style={{ color: "var(--color-fg-muted)" }}>{items.length}</span>
        </span>
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
  const stage = useGit((s) => s.stage);
  const unstage = useGit((s) => s.unstage);

  const id = `diff:${change.staged ? "staged" : "working"}:${change.path}`;
  const active = activePath === id;
  const dir = change.path.includes("/") ? change.path.slice(0, change.path.lastIndexOf("/")) : "";
  const name = change.path.slice(change.path.lastIndexOf("/") + 1);
  const { letter, color } = badge(change.status);

  return (
    <div
      className="group/row flex items-center"
      style={{
        background: active ? "var(--color-accent-quiet)" : "transparent",
        padding: "0 var(--space-4)",
      }}
    >
      <button
        type="button"
        onClick={() => openDiff(change.path, change.staged)}
        title={`${change.path} — ${change.status}`}
        className="flex min-w-0 flex-1 cursor-pointer items-center"
        style={{
          border: "none",
          background: "transparent",
          padding: "3px 0",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          textAlign: "left",
          overflow: "hidden",
        }}
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: active ? "var(--color-fg-primary)" : "var(--color-fg-secondary)",
          }}
        >
          {name}
        </span>
        {dir && (
          <span
            style={{ marginLeft: "var(--space-2)", color: "var(--color-fg-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {dir}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={() => void (change.staged ? unstage(change.path) : stage(change.path))}
        title={change.staged ? "Unstage" : "Stage"}
        aria-label={change.staged ? `Unstage ${name}` : `Stage ${name}`}
        className="shrink-0 cursor-pointer opacity-0 group-hover/row:opacity-100"
        style={{
          border: "none",
          background: "transparent",
          color: "var(--color-fg-secondary)",
          fontSize: "var(--text-sm)",
          lineHeight: 1,
          padding: "0 var(--space-2)",
        }}
      >
        {change.staged ? "－" : "＋"}
      </button>
      <span
        aria-hidden="true"
        className="shrink-0"
        style={{ color, width: "1em", textAlign: "center", fontWeight: 600, fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}
      >
        {letter}
      </span>
    </div>
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
      <BranchSwitcher branch={branch} sync={sync} />
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

/** Branch label that opens a switch/create menu (VS Code's status-bar branch). */
function BranchSwitcher({ branch, sync }: { branch: string | null; sync: string }) {
  const data = useGit((s) => s.branches);
  const switchBranch = useGit((s) => s.switchBranch);
  const createBranch = useGit((s) => s.createBranch);
  const loadBranches = useGit((s) => s.loadBranches);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const list = data?.branches ?? [];
  const current = data?.current ?? branch;

  const close = () => {
    setOpen(false);
    setCreating(false);
    setName("");
  };
  const toggle = () => {
    const next = !open;
    close();
    setOpen(next);
    if (next) void loadBranches();
  };
  const pick = (b: string) => {
    if (b !== current) void switchBranch(b);
    close();
  };
  const create = () => {
    const n = name.trim();
    if (!n) return;
    void createBranch(n);
    close();
  };

  return (
    <span className="relative flex min-w-0 items-center">
      <button
        type="button"
        onClick={toggle}
        title="Switch or create branch"
        aria-label={`Branch ${branch ?? "none"}. Switch or create a branch.`}
        aria-expanded={open}
        className="flex min-w-0 cursor-pointer items-center gap-[var(--space-2)]"
        style={{
          border: "none",
          background: "transparent",
          color: "var(--color-fg-secondary)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          padding: 0,
          overflow: "hidden",
        }}
      >
        <span aria-hidden="true">⎇</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {branch ?? "—"}
        </span>
        {sync && <span style={{ color: "var(--color-fg-muted)" }}>{sync}</span>}
        <span aria-hidden="true" style={{ color: "var(--color-fg-muted)" }}>
          ▾
        </span>
      </button>
      {open && (
        <>
          <div onClick={close} className="fixed inset-0" style={{ zIndex: 30 }} aria-hidden="true" />
          <div
            role="menu"
            className="absolute overflow-y-auto"
            style={{
              top: "calc(100% + var(--space-2))",
              left: 0,
              minWidth: "220px",
              maxHeight: "280px",
              zIndex: 31,
              background: "var(--color-bg-raised)",
              border: "1px solid var(--color-border-strong)",
              borderRadius: "var(--radius-md)",
              padding: "var(--space-2)",
              boxShadow: "0 8px 24px rgba(0, 0, 0, 0.4)",
            }}
          >
            {list.length === 0 ? (
              <p style={{ ...menuText, color: "var(--color-fg-muted)" }}>No local branches.</p>
            ) : (
              list.map((b) => (
                <button
                  key={b}
                  type="button"
                  role="menuitem"
                  onClick={() => pick(b)}
                  className="flex w-full cursor-pointer items-center gap-[var(--space-2)] text-left"
                  style={{ ...menuItem, color: "var(--color-fg-primary)" }}
                >
                  <span style={{ width: "1em", color: "var(--color-status-running)" }}>
                    {b === current ? "●" : ""}
                  </span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {b}
                  </span>
                </button>
              ))
            )}
            <div
              style={{ borderTop: "1px solid var(--color-border-subtle)", margin: "var(--space-2) 0" }}
            />
            {creating ? (
              <div className="flex items-center gap-[var(--space-2)]" style={{ padding: "0 var(--space-2)" }}>
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      create();
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setCreating(false);
                      setName("");
                    }
                  }}
                  placeholder="new-branch-name"
                  spellCheck={false}
                  aria-label="New branch name"
                  className="min-w-0 flex-1"
                  style={{
                    background: "var(--color-bg-recessed)",
                    border: "1px solid var(--color-border-subtle)",
                    borderRadius: "var(--radius-sm)",
                    color: "var(--color-fg-primary)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-xs)",
                    padding: "3px var(--space-2)",
                    outline: "none",
                  }}
                />
                <button
                  type="button"
                  onClick={create}
                  disabled={!name.trim()}
                  className={name.trim() ? "cursor-pointer" : undefined}
                  style={{
                    padding: "3px var(--space-2)",
                    border: "1px solid var(--color-border-subtle)",
                    borderRadius: "var(--radius-sm)",
                    background: name.trim() ? "var(--color-accent-quiet)" : "transparent",
                    color: name.trim() ? "var(--color-fg-primary)" : "var(--color-fg-muted)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-xs)",
                  }}
                >
                  Create
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="flex w-full cursor-pointer items-center gap-[var(--space-2)] text-left"
                style={{ ...menuItem, color: "var(--color-fg-secondary)" }}
              >
                <span aria-hidden="true">＋</span> Create new branch…
              </button>
            )}
          </div>
        </>
      )}
    </span>
  );
}

const menuItem = {
  border: "none",
  background: "transparent",
  padding: "var(--space-2) var(--space-3)",
  borderRadius: "var(--radius-sm)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
} as const;
const menuText = {
  padding: "var(--space-2) var(--space-3)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
} as const;

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
