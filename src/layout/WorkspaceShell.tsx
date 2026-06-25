/*
 * Workspace shell (spec 4.4). The three-region layout — Sessions + Timeline
 * Rail / Conversation hero (widest) / Editor — over a collapsible Terminal
 * drawer, under a workspace tab bar. The three columns are drag-resizable
 * (react-resizable-panels): the sidebar and editor hold their pixel width when
 * the window resizes while the hero absorbs the slack, and the user's chosen
 * split is remembered across reloads via `useDefaultLayout` (localStorage).
 *
 * Phase 5: the Sessions rail and Editor are also dockable — hidden/shown from
 * the top-bar toggles or Ctrl/Cmd+B (and Ctrl/Cmd+J for the terminal), with the
 * conversation hero absorbing the freed space. The hero is never hidden. The
 * `layout` store holds visibility intent; the panels reconcile to it, and a
 * manual drag-to-collapse syncs the store back so the toggles stay truthful.
 */

import type { CSSProperties } from "react";
import { useEffect } from "react";
import { Group, Panel, useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { SessionsPanel } from "@/layout/SessionsPanel";
import { ConversationPane } from "@/layout/ConversationPane";
import { EditorRegion } from "@/layout/EditorRegion";
import { ResizeSeparator } from "@/layout/ResizeSeparator";
import { TerminalDrawer } from "@/layout/TerminalDrawer";
import { useLayoutShortcuts } from "@/layout/useLayoutShortcuts";
import { useLayout, type Region } from "@/store/layout";

// Each panel's content fills it and clips internally (the regions own their own
// scroll); applied to the nested content div the library renders.
const PANEL: CSSProperties = { height: "100%", overflow: "hidden" };

export function WorkspaceShell() {
  const layout = useDefaultLayout({ id: "ide:workspace" });
  const sessionsVisible = useLayout((s) => s.sessions);
  const editorVisible = useLayout((s) => s.editor);
  const setVisible = useLayout((s) => s.setVisible);

  const sessionsRef = usePanelRef();
  const editorRef = usePanelRef();

  useLayoutShortcuts();

  // Reconcile each collapsible side panel to the store's visibility intent.
  // collapse()/expand() are no-ops when already in the target state, so this is
  // safe to run on every change (and on mount, to honour persisted visibility).
  useEffect(() => {
    sessionsRef.current?.[sessionsVisible ? "expand" : "collapse"]();
  }, [sessionsVisible, sessionsRef]);
  useEffect(() => {
    editorRef.current?.[editorVisible ? "expand" : "collapse"]();
  }, [editorVisible, editorRef]);

  // Sync a manual drag-to-collapse (or drag-open) back into the store so the
  // toggles reflect reality. The mount callback (prev === undefined) is skipped
  // so the store's persisted intent — not the library's restored layout — wins
  // at startup; setVisible is a no-op when unchanged, so the store-driven path
  // above can't loop with this one.
  const syncFromDrag =
    (region: Region) =>
    (size: { inPixels: number }, _id: unknown, prev: unknown) => {
      if (prev === undefined) return;
      setVisible(region, size.inPixels > 0);
    };

  return (
    <div className="flex h-full w-full flex-col">
      <TabBar />
      <main className="min-h-0 flex-1 overflow-hidden">
        <Group
          orientation="horizontal"
          defaultLayout={layout.defaultLayout}
          onLayoutChanged={layout.onLayoutChanged}
          style={{ height: "100%", width: "100%" }}
        >
          <Panel
            id="sessions"
            defaultSize="260px"
            minSize="180px"
            maxSize="40%"
            collapsible
            collapsedSize={0}
            panelRef={sessionsRef}
            onResize={syncFromDrag("sessions")}
            groupResizeBehavior="preserve-pixel-size"
            style={PANEL}
          >
            <SessionsPanel />
          </Panel>
          {sessionsVisible && <ResizeSeparator orientation="horizontal" />}
          <Panel id="conversation" minSize="320px" style={PANEL}>
            <ConversationPane />
          </Panel>
          {editorVisible && <ResizeSeparator orientation="horizontal" />}
          <Panel
            id="editor"
            defaultSize="560px"
            minSize="380px"
            collapsible
            collapsedSize={0}
            panelRef={editorRef}
            onResize={syncFromDrag("editor")}
            groupResizeBehavior="preserve-pixel-size"
            style={PANEL}
          >
            <EditorRegion />
          </Panel>
        </Group>
      </main>
      <TerminalDrawer />
    </div>
  );
}

function TabBar() {
  return (
    <div
      className="flex shrink-0 items-center justify-between gap-[var(--space-3)]"
      style={{
        height: "var(--space-7)",
        padding: "0 var(--space-3) 0 var(--space-4)",
        background: "var(--color-bg-recessed)",
        borderBottom: "1px solid var(--color-border-subtle)",
      }}
    >
      <div
        className="flex items-center gap-[var(--space-3)]"
        style={{
          height: "calc(var(--space-7) - var(--space-2))",
          padding: "0 var(--space-4)",
          borderRadius: "var(--radius-sm)",
          background: "var(--color-bg-raised)",
        }}
      >
        <span
          className="status-lamp-pulse"
          aria-hidden="true"
          style={{
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            background: "var(--color-status-running)",
          }}
        />
        <span
          style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--color-fg-primary)" }}
        >
          claude-ide
        </span>
      </div>
      <PanelToggles />
    </div>
  );
}

// Top-bar dock toggles for the three hideable regions. The conversation hero is
// the center of gravity and has no toggle. Active = region visible.
function PanelToggles() {
  const sessions = useLayout((s) => s.sessions);
  const editor = useLayout((s) => s.editor);
  const terminal = useLayout((s) => s.terminal);
  const toggle = useLayout((s) => s.toggle);

  return (
    <div role="group" aria-label="Toggle panels" className="flex items-center gap-[var(--space-1)]">
      <ToggleButton glyph="◧" label="Sessions rail" shortcut="Ctrl+B" active={sessions} onClick={() => toggle("sessions")} />
      <ToggleButton glyph="◨" label="Editor" active={editor} onClick={() => toggle("editor")} />
      <ToggleButton glyph="▁" label="Terminal" shortcut="Ctrl+J" active={terminal} onClick={() => toggle("terminal")} />
    </div>
  );
}

function ToggleButton({
  glyph,
  label,
  shortcut,
  active,
  onClick,
}: {
  glyph: string;
  label: string;
  shortcut?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={`${active ? "Hide" : "Show"} ${label}`}
      title={`${active ? "Hide" : "Show"} ${label}${shortcut ? ` (${shortcut})` : ""}`}
      className="flex cursor-pointer items-center justify-center"
      style={{
        width: "var(--space-6)",
        height: "var(--space-6)",
        border: "none",
        borderRadius: "var(--radius-sm)",
        background: active ? "var(--color-accent-quiet)" : "transparent",
        color: active ? "var(--color-fg-primary)" : "var(--color-fg-muted)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-sm)",
        lineHeight: 1,
      }}
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  );
}
