/*
 * Side panel (Addendum II layout pass). The collapsible content area beside the
 * activity bar: it renders whichever view the activity bar has selected — Files,
 * Search, Source Control, Sessions, Permissions, or Dashboard. Only the active
 * view mounts. The panel collapses (via the activity bar's chevron, the active icon,
 * or Ctrl+B) while the activity bar stays put — so a view is always one click
 * away (VS Code-style).
 */

import { AgentDefsPanel } from "@/layout/AgentDefsPanel";
import { FileExplorer } from "@/layout/FileExplorer";
import { GitPanel } from "@/layout/GitPanel";
import { PermissionsPanel } from "@/layout/PermissionsPanel";
import { SearchPanel } from "@/layout/SearchPanel";
import { SessionsPanel } from "@/layout/SessionsPanel";
import { UsagePanel } from "@/layout/UsagePanel";
import { useLayout, type View } from "@/store/layout";

const LABELS: Record<View, string> = {
  files: "Files",
  search: "Search",
  git: "Source Control",
  sessions: "Sessions",
  agentDefs: "Agents",
  permissions: "Permissions",
  usage: "Dashboard",
};

export function SidePanel() {
  const view = useLayout((s) => s.view);
  return (
    <div
      id="side-panel"
      role="tabpanel"
      aria-label={`${LABELS[view]} view`}
      className="h-full min-h-0 min-w-0 overflow-hidden"
      style={{ background: "var(--color-bg-raised)" }}
    >
      {view === "files" ? (
        <FileExplorer />
      ) : view === "search" ? (
        <SearchPanel />
      ) : view === "git" ? (
        <GitPanel />
      ) : view === "sessions" ? (
        <SessionsPanel />
      ) : view === "agentDefs" ? (
        <AgentDefsPanel />
      ) : view === "permissions" ? (
        <PermissionsPanel />
      ) : (
        <UsagePanel />
      )}
    </div>
  );
}
