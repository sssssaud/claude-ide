/*
 * Editor tab strip (spec 5.A.3). One tab per open file: active highlight, a
 * dirty dot that turns into an ✕ on hover, middle-click to close, full-path
 * tooltip, and horizontal scroll when tabs overflow. Lightweight (no Monaco) so
 * it renders instantly above the editor host.
 */

import { useState } from "react";
import { useEditor } from "@/store/editor";

export function EditorTabs() {
  const tabs = useEditor((s) => s.tabs);
  const activePath = useEditor((s) => s.activePath);
  const dirty = useEditor((s) => s.dirty);
  const activate = useEditor((s) => s.activate);
  const close = useEditor((s) => s.close);
  const [hovered, setHovered] = useState<string | null>(null);

  return (
    <div
      role="tablist"
      aria-label="Open editors"
      className="flex shrink-0 overflow-x-auto"
      style={{
        height: "var(--space-7)",
        background: "var(--color-bg-raised)",
        borderBottom: "1px solid var(--color-border-subtle)",
      }}
    >
      {tabs.map((tab) => {
        const active = tab.path === activePath;
        const isDiff = tab.kind === "diff";
        const isDirty = !isDiff && !!dirty[tab.path];
        const showClose = hovered === tab.path || active;
        const title =
          isDiff && tab.diff
            ? `${tab.diff.file} — ${tab.diff.staged ? "Staged changes" : "Working tree"} (diff)`
            : tab.path;
        return (
          <div
            key={tab.path}
            role="tab"
            aria-selected={active}
            title={title}
            onMouseEnter={() => setHovered(tab.path)}
            onMouseLeave={() => setHovered((h) => (h === tab.path ? null : h))}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                close(tab.path); // middle-click closes
              }
            }}
            onClick={() => activate(tab.path)}
            className="group flex shrink-0 cursor-pointer items-center gap-[var(--space-2)]"
            style={{
              height: "100%",
              padding: "0 var(--space-3)",
              maxWidth: "200px",
              borderRight: "1px solid var(--color-border-subtle)",
              borderTop: active
                ? "1px solid var(--color-accent)"
                : "1px solid transparent",
              background: active ? "var(--color-bg-recessed)" : "transparent",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: active ? "var(--color-fg-primary)" : "var(--color-fg-secondary)",
            }}
          >
            <span aria-hidden="true" style={{ opacity: 0.7 }}>
              {isDiff ? "⇄" : "📄"}
            </span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {tab.name}
            </span>
            <button
              type="button"
              aria-label={isDirty ? `Close ${tab.name} (unsaved)` : `Close ${tab.name}`}
              onClick={(e) => {
                e.stopPropagation();
                close(tab.path);
              }}
              className="flex cursor-pointer items-center justify-center"
              style={{
                width: "16px",
                height: "16px",
                marginLeft: "var(--space-1)",
                border: "none",
                background: "transparent",
                color: "var(--color-fg-muted)",
                borderRadius: "var(--radius-sm)",
                fontSize: "var(--text-sm)",
                lineHeight: 1,
              }}
            >
              {isDirty && !showClose ? "●" : "✕"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
