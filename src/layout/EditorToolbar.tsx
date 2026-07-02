/*
 * Editor toolbar (Addendum II §S5, §4): a small "⋯" overflow button pinned to
 * the top-right of the active editor group, next to the tab strip. Surfaces a
 * handful of editor + agent-bridge actions without needing the Command
 * Palette's keyboard shortcut — Format Document and Go to Line always;
 * the five Claude selection actions (§S4) only when there's something
 * selected to run them on.
 */

import { useEffect, useState } from "react";
import { AGENT_ACTION_LABELS, hasAgentActionTarget, sendAgentAction, type AgentActionKind } from "@/commands/agentActions";
import { getActiveEditorHandle } from "@/store/activeEditorHandle";

const AGENT_KINDS: AgentActionKind[] = ["explain", "refactor", "fix", "tests", "docstring"];

export function EditorToolbar() {
  const [open, setOpen] = useState(false);

  // Re-check whenever the menu opens (not a hot path — opens on a click, not
  // per keystroke), so the Claude rows reflect whatever's selected right now.
  const agentEnabled = open && hasAgentActionTarget();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="relative shrink-0" style={{ height: "100%" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="More editor actions"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More Actions…"
        className="flex h-full cursor-pointer items-center justify-center"
        style={{
          width: "var(--space-7)",
          border: "none",
          background: "transparent",
          color: "var(--color-fg-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-md)",
        }}
      >
        ⋯
      </button>
      {open && (
        <>
          <div className="fixed inset-0" style={{ zIndex: 30 }} onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            role="menu"
            aria-label="Editor actions"
            className="absolute right-0 overflow-hidden"
            style={{
              top: "calc(100% + var(--space-1))",
              minWidth: "220px",
              zIndex: 31,
              background: "var(--color-bg-raised)",
              border: "1px solid var(--color-border-strong)",
              borderRadius: "var(--radius-md)",
              boxShadow: "var(--elev-3)",
              padding: "var(--space-2)",
            }}
          >
            <MenuItem
              label="Format Document"
              onClick={() => {
                setOpen(false);
                void getActiveEditorHandle()?.editor.getAction("editor.action.formatDocument")?.run();
              }}
            />
            <MenuItem
              label="Go to Line/Column…"
              onClick={() => {
                setOpen(false);
                getActiveEditorHandle()?.editor.getAction("editor.action.gotoLine")?.run();
              }}
            />
            <MenuItem
              label="Compare with Checkpoint…"
              onClick={() => {
                setOpen(false);
                getActiveEditorHandle()?.editor.getAction("checkpoints.compareActiveFile")?.run();
              }}
            />
            <MenuItem
              label="Claude: Ask About This Line…"
              onClick={() => {
                setOpen(false);
                getActiveEditorHandle()?.editor.getAction("claude.askLine")?.run();
              }}
            />
            {agentEnabled && (
              <>
                <div style={{ margin: "var(--space-2) 0", borderTop: "1px solid var(--color-border-subtle)" }} />
                {AGENT_KINDS.map((kind) => (
                  <MenuItem
                    key={kind}
                    label={`Claude: ${AGENT_ACTION_LABELS[kind]}`}
                    onClick={() => {
                      setOpen(false);
                      sendAgentAction(kind);
                    }}
                  />
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center text-left transition-colors hover:bg-[var(--color-bg-overlay)]"
      style={{
        padding: "var(--space-2) var(--space-3)",
        border: "none",
        background: "transparent",
        borderRadius: "var(--radius-sm)",
        color: "var(--color-fg-primary)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-sm)",
        transitionDuration: "var(--motion-fast)",
      }}
    >
      {label}
    </button>
  );
}
