/*
 * Editor region (spec 5.A.3, 4.6). The editor surface: a tab strip over the
 * Monaco host. (The file explorer now lives in the far-left activity-bar side
 * panel, not here — Addendum II layout pass.) Monaco stays OUT of the initial
 * bundle and unloaded until the first file is opened (idle memory stays lean).
 *
 * Phase 5 (B5): editor tabs are per-workspace. Each open workspace that has ≥1
 * tab gets its OWN host instance, kept mounted and just hidden when inactive —
 * so switching workspaces preserves every project's open files, scroll, cursor,
 * undo, and unsaved buffers (keep-alive), with no model collision.
 *
 * The Settings tab (kind "settings") renders the Settings surface in place of
 * Monaco; the editor host is hidden with `display:none` while it shows (state
 * preserved, and a hidden editor can't paint widgets through Settings).
 */

import { lazy, Suspense } from "react";
import { useStore } from "zustand";
import { EmptyState, LoadingState } from "@/components/states";
import { EditorTabs } from "@/layout/EditorTabs";
import { SettingsView } from "@/layout/SettingsView";
import { editorStoreFor, useActiveEditor } from "@/store/editor";
import { useWorkspaces } from "@/store/workspaces";

// Lazy boundary keeps Monaco out of the initial chunk until a file/diff opens.
const EditorPane = lazy(() => import("@/layout/EditorPane").then((m) => ({ default: m.EditorPane })));
const DiffView = lazy(() => import("@/layout/DiffView").then((m) => ({ default: m.DiffView })));

export function EditorRegion() {
  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeId = useWorkspaces((s) => s.activeId);

  return (
    <div className="relative h-full min-h-0 overflow-hidden">
      {/* One kept-alive host per workspace with tabs; only the active one is
          shown. Empty workspaces mount nothing (no idle Monaco). */}
      {workspaces.map((w) => (
        <WorkspaceEditor key={w.id} cwd={w.id} active={w.id === activeId} />
      ))}
      <ActiveEmptyState />
    </div>
  );
}

/** One workspace's editor surface (tab strip + Monaco host + diff/settings),
 *  bound to that workspace's store. Renders nothing until the workspace has a
 *  tab; stays mounted (hidden) once it does, which preserves its state. */
function WorkspaceEditor({ cwd, active }: { cwd: string; active: boolean }) {
  const store = editorStoreFor(cwd);
  const tabs = useStore(store, (s) => s.tabs);
  const activePath = useStore(store, (s) => s.activePath);

  if (tabs.length === 0) return null;

  const activeTab = tabs.find((t) => t.path === activePath) ?? null;
  const showDiff = activeTab?.kind === "diff";
  const showSettings = activeTab?.kind === "settings";
  // Only mount the Monaco host when there's real editor content (so opening
  // Settings alone never loads Monaco).
  const hasEditorContent = tabs.some((t) => t.kind !== "settings");

  return (
    <div className="absolute inset-0 flex min-h-0 flex-col overflow-hidden" style={{ display: active ? "flex" : "none" }} aria-hidden={!active}>
      <EditorTabs store={store} />
      <div className="relative min-h-0 flex-1">
        {hasEditorContent && (
          // Hidden (not unmounted) while Settings shows: file models are
          // preserved and a hidden editor can't bleed through the Settings view.
          <div className="absolute inset-0" style={{ display: showSettings ? "none" : "block" }}>
            <Suspense fallback={<LoadingState label="Loading editor…" />}>
              <EditorPane cwd={cwd} store={store} active={active} />
            </Suspense>
            {showDiff && activeTab && (
              <div className="absolute inset-0">
                <Suspense fallback={<LoadingState label="Loading diff…" />}>
                  <DiffView key={activeTab.path} tab={activeTab} cwd={cwd} />
                </Suspense>
              </div>
            )}
          </div>
        )}
        {showSettings && (
          <div className="absolute inset-0">
            <SettingsView />
          </div>
        )}
      </div>
    </div>
  );
}

/** The "nothing open" state — shown only when the ACTIVE workspace has no tabs. */
function ActiveEmptyState() {
  const tabs = useActiveEditor((s) => s.tabs);
  if (tabs.length > 0) return null;
  return (
    <div className="absolute inset-0">
      <EmptyState title="No file open" hint="Pick a file from the explorer to view it. Monaco loads on demand." />
    </div>
  );
}
