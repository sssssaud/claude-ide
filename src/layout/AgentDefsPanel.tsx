/*
 * Agent definitions view (Addendum II §S8) — author, edit, and quick-launch
 * project-scoped custom sub-agents (`.claude/agents/*.md`, the CLI's own
 * file format: YAML frontmatter + a markdown system-prompt body). The CLI
 * loads and runs these; this panel only authors the files.
 *
 * Project-only for now — the user-global `~/.claude/agents/` directory is
 * explicitly deferred to a later phase (per the app's own roadmap). Distinct
 * from `AgentsSection.tsx` (the Sessions rail's live/background-session
 * dashboard over `claude agents --json`) — that watches agents RUN; this
 * panel is about DEFINING one. Both share the "Agents" idea but not a file.
 *
 * Quick-launch reuses the exact "Open Terminal Here" mechanism (Addendum II
 * §S7): write `claude --agent <slug>` into the workspace's already-open real
 * shell via the same `getActivePtyId` + `ptyWrite` pair — zero new exec
 * surface, since it's just typing into a shell the user already owns.
 */

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { AppButton, EmptyState, ErrorState, LoadingState } from "@/components/states";
import {
  createAgentDef,
  deleteAgentDef,
  listAgentDefs,
  ptyWrite,
  readAgentDef,
  updateAgentDef,
} from "@/ipc/commands";
import { isIpcError, type AgentDef, type AgentDefSummary, type IpcError } from "@/ipc/types";
import { getActivePtyId } from "@/store/activeTerminals";
import { useLayout } from "@/store/layout";
import { useActiveCwd } from "@/store/workspaces";

const EMPTY_DRAFT: AgentDef = { slug: "", description: "", tools: [], model: "", prompt: "" };

type Mode = { kind: "list" } | { kind: "create" } | { kind: "edit"; original: string };

function toError(e: unknown, fallback: string): IpcError {
  return isIpcError(e) ? e : { kind: "internal", message: fallback };
}

export function AgentDefsPanel() {
  const cwd = useActiveCwd();
  const [items, setItems] = useState<AgentDefSummary[] | null>(null);
  const [listError, setListError] = useState<IpcError | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [draft, setDraft] = useState<AgentDef>(EMPTY_DRAFT);
  const [formLoading, setFormLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [launchNote, setLaunchNote] = useState<string | null>(null);

  const load = useCallback(() => {
    setItems(null);
    setListError(null);
    let alive = true;
    listAgentDefs(cwd ?? undefined)
      .then((r) => alive && setItems(r))
      .catch((e) => alive && setListError(toError(e, "Could not load agents")));
    return () => {
      alive = false;
    };
  }, [cwd]);

  useEffect(() => load(), [load]);

  const startCreate = () => {
    setDraft(EMPTY_DRAFT);
    setSaveError(null);
    setMode({ kind: "create" });
  };

  const startEdit = (slug: string) => {
    setMode({ kind: "edit", original: slug });
    setSaveError(null);
    setFormLoading(true);
    readAgentDef(slug, cwd ?? undefined)
      .then((def) => setDraft(def))
      .catch((e) => setSaveError(isIpcError(e) ? e.message : "Could not load the agent"))
      .finally(() => setFormLoading(false));
  };

  const cancelForm = () => {
    setMode({ kind: "list" });
    setSaveError(null);
  };

  const save = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    const payload: AgentDef = { ...draft, slug: draft.slug.trim().toLowerCase() };
    try {
      if (mode.kind === "create") {
        await createAgentDef(payload, cwd ?? undefined);
      } else if (mode.kind === "edit") {
        await updateAgentDef(mode.original, payload, cwd ?? undefined);
      }
      setMode({ kind: "list" });
      load();
    } catch (e) {
      setSaveError(isIpcError(e) ? e.message : "Could not save the agent");
    } finally {
      setSaving(false);
    }
  }, [draft, mode, cwd, load]);

  const doDelete = async (slug: string) => {
    setDeleting(slug);
    setDeleteError(null);
    try {
      await deleteAgentDef(slug, cwd ?? undefined);
      setPendingDelete(null);
      load();
    } catch (e) {
      setDeleteError(isIpcError(e) ? e.message : "Could not delete the agent");
    } finally {
      setDeleting(null);
    }
  };

  const quickLaunch = (slug: string) => {
    setLaunchNote(null);
    if (!cwd) return;
    useLayout.getState().setVisible("terminal", true);
    useLayout.getState().setBottomTab("terminal");
    const ptyId = getActivePtyId(cwd);
    if (ptyId) {
      void ptyWrite(ptyId, `claude --agent ${slug}\n`);
    } else {
      setLaunchNote("Open a terminal first, then try launching again.");
    }
  };

  if (mode.kind !== "list") {
    return (
      <AgentForm
        mode={mode}
        draft={draft}
        setDraft={setDraft}
        loading={formLoading}
        saving={saving}
        error={saveError}
        onSave={() => void save()}
        onCancel={cancelForm}
      />
    );
  }

  if (listError) return <ErrorState title="Could not load agents" error={listError} onRetry={load} />;
  if (items === null) return <LoadingState label="Loading agents…" />;

  return (
    <div className="flex h-full flex-col overflow-y-auto" style={{ padding: "var(--space-4)" }}>
      <div
        className="flex items-center justify-between"
        style={{ marginBottom: "var(--space-3)" }}
      >
        <div>
          <div style={{ fontSize: "var(--text-sm)", color: "var(--color-fg-primary)" }}>
            Agents
          </div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--color-fg-muted)",
              marginTop: "2px",
            }}
          >
            .claude/agents · project-scoped
          </div>
        </div>
        <AppButton onClick={startCreate}>+ New</AppButton>
      </div>

      {launchNote && (
        <div style={{ marginBottom: "var(--space-2)", fontSize: "var(--text-xs)", color: "var(--color-fg-muted)" }}>
          {launchNote}
        </div>
      )}
      {deleteError && (
        <div
          role="alert"
          style={{ marginBottom: "var(--space-2)", fontSize: "var(--text-xs)", color: "var(--color-status-danger)" }}
        >
          {deleteError}
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState
          title="No custom agents yet"
          hint="Author a project-scoped sub-agent — the claude CLI loads it straight from .claude/agents/."
          action={<AppButton onClick={startCreate}>New agent</AppButton>}
        />
      ) : (
        <ul className="flex flex-col gap-[var(--space-2)]">
          {items.map((a) => (
            <li key={a.slug} style={rowStyle}>
              <div className="flex items-start justify-between gap-[var(--space-2)]">
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", color: "var(--color-fg-primary)" }}>
                    {a.slug}
                  </div>
                  <div
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--color-fg-secondary)",
                      marginTop: "2px",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                    }}
                  >
                    {a.description || "(no description)"}
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--text-xs)",
                      color: "var(--color-fg-muted)",
                      marginTop: "2px",
                    }}
                  >
                    {a.model || "inherits model"} · {a.tools.length ? a.tools.join(", ") : "all tools"}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-[var(--space-2)]" style={{ marginTop: "var(--space-2)" }}>
                <button
                  type="button"
                  title={`Run claude --agent ${a.slug} in the terminal`}
                  onClick={() => quickLaunch(a.slug)}
                  className="cursor-pointer"
                  style={smallBtnStyle}
                >
                  ▶ Launch
                </button>
                <button type="button" onClick={() => startEdit(a.slug)} className="cursor-pointer" style={smallBtnStyle}>
                  Edit
                </button>
                {pendingDelete === a.slug ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void doDelete(a.slug)}
                      disabled={deleting === a.slug}
                      className="cursor-pointer"
                      style={{ ...smallBtnStyle, color: "var(--color-status-danger)" }}
                    >
                      {deleting === a.slug ? "Deleting…" : "Confirm delete?"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingDelete(null)}
                      className="cursor-pointer"
                      style={smallBtnStyle}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setPendingDelete(a.slug)}
                    className="cursor-pointer"
                    style={{ ...smallBtnStyle, marginLeft: "auto", color: "var(--color-fg-muted)" }}
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AgentForm({
  mode,
  draft,
  setDraft,
  loading,
  saving,
  error,
  onSave,
  onCancel,
}: {
  mode: Extract<Mode, { kind: "create" | "edit" }>;
  draft: AgentDef;
  setDraft: (fn: (d: AgentDef) => AgentDef) => void;
  loading: boolean;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  if (loading) return <LoadingState label="Loading agent…" />;

  const canSave = draft.slug.trim().length > 0 && draft.description.trim().length > 0 && draft.prompt.trim().length > 0;

  return (
    <div className="flex h-full flex-col overflow-y-auto" style={{ padding: "var(--space-4)" }}>
      <div style={{ fontSize: "var(--text-sm)", color: "var(--color-fg-primary)", marginBottom: "var(--space-3)" }}>
        {mode.kind === "create" ? "New agent" : `Edit — ${mode.original}`}
      </div>

      {error && (
        <div role="alert" style={{ marginBottom: "var(--space-2)", fontSize: "var(--text-xs)", color: "var(--color-status-danger)" }}>
          {error}
        </div>
      )}

      <Field label="Name (lowercase-kebab-case — also the claude --agent id)">
        <input
          value={draft.slug}
          onChange={(e) => setDraft((d) => ({ ...d, slug: e.target.value }))}
          placeholder="code-reviewer"
          spellCheck={false}
          className="w-full"
          style={inputStyle}
        />
      </Field>

      <Field label="Description">
        <input
          value={draft.description}
          onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          placeholder="Reviews diffs for correctness and style"
          spellCheck={false}
          className="w-full"
          style={inputStyle}
        />
      </Field>

      <Field label="Tools (comma-separated — blank = inherit all built-in tools)">
        <input
          value={draft.tools.join(", ")}
          onChange={(e) =>
            setDraft((d) => ({
              ...d,
              tools: e.target.value.split(",").map((t) => t.trim()).filter(Boolean),
            }))
          }
          placeholder="Read, Grep, Bash"
          spellCheck={false}
          className="w-full"
          style={inputStyle}
        />
      </Field>

      <Field label="Model (blank = inherit the session's default)">
        <input
          value={draft.model}
          onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
          placeholder="sonnet"
          spellCheck={false}
          className="w-full"
          style={inputStyle}
        />
      </Field>

      <Field label="System prompt">
        <textarea
          value={draft.prompt}
          onChange={(e) => setDraft((d) => ({ ...d, prompt: e.target.value }))}
          placeholder="You are a…"
          spellCheck={false}
          rows={12}
          className="w-full"
          style={{ ...inputStyle, resize: "vertical", fontFamily: "var(--font-mono)" }}
        />
      </Field>

      <div className="flex items-center gap-[var(--space-2)]" style={{ marginTop: "var(--space-2)" }}>
        <AppButton onClick={onSave}>{saving ? "Saving…" : "Save"}</AppButton>
        <AppButton variant="ghost" onClick={onCancel}>
          Cancel
        </AppButton>
      </div>
      {!canSave && (
        <div style={{ marginTop: "var(--space-2)", fontSize: "var(--text-xs)", color: "var(--color-fg-muted)" }}>
          Name, description, and a system prompt are required.
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col" style={{ marginBottom: "var(--space-3)", gap: "2px" }}>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--color-fg-muted)" }}>
        {label}
      </span>
      {children}
    </label>
  );
}

const rowStyle: CSSProperties = {
  padding: "var(--space-2) var(--space-3)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-bg-base)",
  border: "1px solid var(--color-border-subtle)",
};

const smallBtnStyle: CSSProperties = {
  border: "none",
  borderRadius: "var(--radius-sm)",
  padding: "2px var(--space-2)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  lineHeight: 1.6,
  background: "transparent",
  color: "var(--color-fg-secondary)",
};

const inputStyle: CSSProperties = {
  background: "var(--color-bg-base)",
  border: "1px solid var(--color-border-subtle)",
  borderRadius: "var(--radius-sm)",
  padding: "var(--space-1) var(--space-2)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--color-fg-primary)",
};
