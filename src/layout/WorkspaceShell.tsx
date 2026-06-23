/*
 * Workspace shell (spec 4.4). The three-region layout — Sessions + Timeline
 * Rail / Conversation hero (widest) / Editor — over a collapsible Terminal
 * drawer, under a workspace tab bar. Phase 0 establishes the structure with
 * dummy data; resizable/dockable panels and live multi-workspace routing land
 * in Phase 5.
 */

import { SessionsPanel } from "@/layout/SessionsPanel";
import { ConversationPane } from "@/layout/ConversationPane";
import { EditorRegion } from "@/layout/EditorRegion";
import { TerminalDrawer } from "@/layout/TerminalDrawer";

export function WorkspaceShell() {
  return (
    <div className="flex h-full w-full flex-col">
      <TabBar />
      <main
        className="grid min-h-0 flex-1 overflow-hidden"
        style={{
          // Hero (conversation) widest; sessions fixed; editor region holds the
          // file explorer + Monaco, so it needs room for both (min 500px).
          gridTemplateColumns: "260px minmax(0, 1.2fr) minmax(500px, 1fr)",
          // Pin the row to the container height. Without an explicit row, the
          // implicit `auto` track grows to its tallest column's content and
          // ignores this height — pushing each column's footer (e.g. the
          // conversation prompt bar) below the clipped viewport. `minmax(0,1fr)`
          // bounds the row so every column scrolls inside it instead.
          gridTemplateRows: "minmax(0, 1fr)",
        }}
      >
        <SessionsPanel />
        <ConversationPane />
        <div
          className="min-h-0 overflow-hidden"
          style={{ borderLeft: "1px solid var(--color-border-subtle)" }}
        >
          <EditorRegion />
        </div>
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
