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
        className="grid min-h-0 flex-1"
        style={{
          // Hero (conversation) widest; sessions fixed; editor ~45% of the rest.
          gridTemplateColumns: "280px minmax(0, 1.3fr) minmax(360px, 1fr)",
        }}
      >
        <SessionsPanel />
        <ConversationPane />
        <div style={{ borderLeft: "1px solid var(--color-border-subtle)" }}>
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
