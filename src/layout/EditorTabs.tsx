/*
 * Editor tab strip (spec 5.A.3). One tab per open file: active highlight, a
 * dirty dot that turns into an ✕ on hover, middle-click to close, full-path
 * tooltip, and horizontal scroll when tabs overflow. Lightweight (no Monaco) so
 * it renders instantly above the editor host.
 */

import { useState } from "react";
import { useStore, type StoreApi } from "zustand";
import type { EditorState } from "@/store/editor";
import { useSettings } from "@/store/settings";

export function EditorTabs({ store }: { store: StoreApi<EditorState> }) {
  const tabs = useStore(store, (s) => s.tabs);
  const activePath = useStore(store, (s) => s.activePath);
  const dirty = useStore(store, (s) => s.dirty);
  const activate = useStore(store, (s) => s.activate);
  const close = useStore(store, (s) => s.close);
  // The Settings tab's dirty/close go through the settings store (staged Apply),
  // so closing with unapplied changes can prompt first.
  const settingsDirty = useSettings((s) => s.dirty);
  const [hovered, setHovered] = useState<string | null>(null);

  // Close a tab: the Settings tab routes through requestClose (which prompts on
  // unapplied changes); everything else closes immediately.
  const closeTab = (path: string, kind: EditorState["tabs"][number]["kind"]) => {
    if (kind === "settings") useSettings.getState().requestClose();
    else close(path);
  };

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
        const isSettings = tab.kind === "settings";
        const isDirty = isSettings ? settingsDirty : !isDiff && !!dirty[tab.path];
        const showClose = hovered === tab.path || active;
        const title =
          isSettings
            ? "Settings"
            : isDiff && tab.diff
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
                closeTab(tab.path, tab.kind); // middle-click closes
              }
            }}
            onClick={() => activate(tab.path)}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                activate(tab.path);
              }
            }}
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
              {isSettings ? "⚙" : isDiff ? "⇄" : "📄"}
            </span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {tab.name}
            </span>
            <button
              type="button"
              aria-label={isDirty ? `Close ${tab.name} (unsaved)` : `Close ${tab.name}`}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.path, tab.kind);
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
