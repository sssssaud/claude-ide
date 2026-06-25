/*
 * Editor region (spec 5.A.3, 4.6). The file explorer beside the editor surface:
 * a tab strip over the Monaco host. The explorer▏code split is drag-resizable
 * (react-resizable-panels) with its own remembered width. Monaco stays OUT of
 * the initial bundle and unloaded until the first file is opened (idle memory
 * stays lean, spec 2.7).
 *
 * Phase 5 (B5): editor tabs are per-workspace. Each open workspace that has ≥1
 * tab gets its OWN host instance, kept mounted and just hidden when inactive —
 * so switching workspaces preserves every project's open files, scroll, cursor,
 * undo, and unsaved buffers (keep-alive), with no model collision (URIs are
 * keyed by absolute path). The active workspace's tabs drive what shows; when it
 * has nothing open, the code side shows the empty state and no host is mounted
 * for it.
 */

import type { CSSProperties } from "react";
import { lazy, Suspense } from "react";
import { useStore } from "zustand";
import { Group, Panel, useDefaultLayout } from "react-resizable-panels";
import { EmptyState, LoadingState } from "@/components/states";
import { EditorTabs } from "@/layout/EditorTabs";
import { ResizeSeparator } from "@/layout/ResizeSeparator";
import { Sidebar } from "@/layout/Sidebar";
import { editorStoreFor, useActiveEditor } from "@/store/editor";
import { useWorkspaces } from "@/store/workspaces";

// Lazy boundary keeps Monaco out of the initial chunk until a file/diff opens.
const EditorPane = lazy(() =>
  import("@/layout/EditorPane").then((m) => ({ default: m.EditorPane })),
);
const DiffView = lazy(() => import("@/layout/DiffView").then((m) => ({ default: m.DiffView })));

const PANEL: CSSProperties = { height: "100%", overflow: "hidden" };

export function EditorRegion() {
  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeId = useWorkspaces((s) => s.activeId);
  const layout = useDefaultLayout({ id: "ide:editor" });

  return (
    <Group
      orientation="horizontal"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
      style={{ height: "100%", width: "100%" }}
    >
      <Panel
        id="explorer"
        defaultSize="220px"
        minSize="140px"
        maxSize="60%"
        groupResizeBehavior="preserve-pixel-size"
        style={PANEL}
      >
        <Sidebar />
      </Panel>
      <ResizeSeparator orientation="horizontal" />
      <Panel id="code" minSize="280px" style={PANEL}>
        <div className="relative h-full min-h-0 overflow-hidden">
          {/* One kept-alive host per workspace with tabs; only the active one is
              shown. Empty workspaces mount nothing (no idle Monaco). */}
          {workspaces.map((w) => (
            <WorkspaceEditor key={w.id} cwd={w.id} active={w.id === activeId} />
          ))}
          <ActiveEmptyState />
        </div>
      </Panel>
    </Group>
  );
}

/** One workspace's editor surface (tab strip + Monaco host + diff overlay),
 *  bound to that workspace's store. Renders nothing until the workspace has a
 *  tab, so an unopened project costs no Monaco instance; stays mounted (hidden)
 *  once it does, which is what preserves its state across tab switches. */
function WorkspaceEditor({ cwd, active }: { cwd: string; active: boolean }) {
  const store = editorStoreFor(cwd);
  const tabs = useStore(store, (s) => s.tabs);
  const activePath = useStore(store, (s) => s.activePath);

  if (tabs.length === 0) return null;

  const activeTab = tabs.find((t) => t.path === activePath) ?? null;
  const showDiff = activeTab?.kind === "diff";

  return (
    <div
      className="absolute inset-0 flex min-h-0 flex-col overflow-hidden"
      style={{ display: active ? "flex" : "none" }}
      aria-hidden={!active}
    >
      <EditorTabs store={store} />
      {/* The editor host stays mounted (file models preserved); the diff view
          overlays it when a diff tab is active. */}
      <div className="relative min-h-0 flex-1">
        <Suspense fallback={<LoadingState label="Loading editor…" />}>
          <EditorPane cwd={cwd} store={store} />
        </Suspense>
        {showDiff && activeTab && (
          <div className="absolute inset-0">
            <Suspense fallback={<LoadingState label="Loading diff…" />}>
              <DiffView key={activeTab.path} tab={activeTab} cwd={cwd} />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}

/** The "no file open" state — shown only when the ACTIVE workspace has no tabs
 *  (its own host renders nothing then). Other workspaces' hidden hosts sit
 *  behind this, untouched. */
function ActiveEmptyState() {
  const tabs = useActiveEditor((s) => s.tabs);
  if (tabs.length > 0) return null;
  return (
    <div className="absolute inset-0">
      <EmptyState
        title="No file open"
        hint="Pick a file from the explorer to view it. Monaco loads on demand."
      />
    </div>
  );
}
