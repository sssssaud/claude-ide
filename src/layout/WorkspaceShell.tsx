/*
 * Workspace shell (spec 4.4). The three-region layout — Sessions + Timeline
 * Rail / Conversation hero (widest) / Editor — over a collapsible Terminal
 * drawer, under a workspace tab bar. The three columns are drag-resizable
 * (react-resizable-panels): the sidebar and editor hold their pixel width when
 * the window resizes while the hero absorbs the slack, and the user's chosen
 * split is remembered across reloads via `useDefaultLayout` (localStorage).
 */

import type { CSSProperties } from "react";
import { Group, Panel, useDefaultLayout } from "react-resizable-panels";
import { SessionsPanel } from "@/layout/SessionsPanel";
import { ConversationPane } from "@/layout/ConversationPane";
import { EditorRegion } from "@/layout/EditorRegion";
import { ResizeSeparator } from "@/layout/ResizeSeparator";
import { TerminalDrawer } from "@/layout/TerminalDrawer";

// Each panel's content fills it and clips internally (the regions own their own
// scroll); applied to the nested content div the library renders.
const PANEL: CSSProperties = { height: "100%", overflow: "hidden" };

export function WorkspaceShell() {
  const layout = useDefaultLayout({ id: "ide:workspace" });

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
            groupResizeBehavior="preserve-pixel-size"
            style={PANEL}
          >
            <SessionsPanel />
          </Panel>
          <ResizeSeparator orientation="horizontal" />
          <Panel id="conversation" minSize="320px" style={PANEL}>
            <ConversationPane />
          </Panel>
          <ResizeSeparator orientation="horizontal" />
          <Panel
            id="editor"
            defaultSize="560px"
            minSize="380px"
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
      className="flex shrink-0 items-center gap-[var(--space-3)]"
      style={{
        height: "var(--space-7)",
        padding: "0 var(--space-4)",
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
    </div>
  );
}
