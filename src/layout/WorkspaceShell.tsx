/*
 * Workspace shell (spec 4.4; Addendum II layout pass). VS Code-style layout: a
 * far-left Activity bar (always visible) beside a collapsible Side panel
 * (Explorer / Search / Source Control / Sessions / Permissions / Usage), then the
 * Conversation hero (widest, never hidden), then the Editor — over a collapsible
 * Terminal drawer, under a workspace tab bar.
 *
 * The Side panel and Editor are drag-resizable and dockable: hidden/shown from
 * the activity bar, the top-bar toggles, or Ctrl/Cmd+B (side panel) and
 * Ctrl/Cmd+J (terminal). The conversation hero absorbs freed space. The `layout`
 * store holds visibility intent; the panels reconcile to it, and a manual
 * drag-to-collapse syncs the store back so the toggles stay truthful.
 */

import type { CSSProperties } from "react";
import { useCallback, useEffect, useState } from "react";
import { Group, Panel, useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { ActivityBar } from "@/layout/ActivityBar";
import { BottomPanel } from "@/layout/BottomPanel";
import { CheatSheet } from "@/layout/CheatSheet";
import { CommandPalette } from "@/layout/CommandPalette";
import { ConversationPane } from "@/layout/ConversationPane";
import { EditorRegion } from "@/layout/EditorRegion";
import { QuickOpen } from "@/layout/QuickOpen";
import { ResizeSeparator } from "@/layout/ResizeSeparator";
import { SidePanel } from "@/layout/SidePanel";
import { StatusBar } from "@/layout/StatusBar";
import { useLayoutShortcuts } from "@/layout/useLayoutShortcuts";
import { useSessionBootstrap } from "@/layout/useSessionBootstrap";
import { pickFolder } from "@/ipc/commands";
import { useActiveConversation } from "@/store/conversation";
import { useLayout, type Region } from "@/store/layout";
import { mergeEffectiveAppearance, useSettings } from "@/store/settings";
import { useActiveCwd, useWorkspaces, type Workspace } from "@/store/workspaces";
import { uiZoomFactor, useZoom } from "@/store/zoom";

// Each panel's content fills it and clips internally (the regions own their own
// scroll); applied to the nested content div the library renders.
const PANEL: CSSProperties = { height: "100%", overflow: "hidden" };

export function WorkspaceShell() {
  const layout = useDefaultLayout({ id: "ide:workspace" });
  const sidebarVisible = useLayout((s) => s.sidebar);
  const editorVisible = useLayout((s) => s.editor);
  const zen = useLayout((s) => s.zen);
  const setVisible = useLayout((s) => s.setVisible);
  // Zen mode (§S3) overrides the Side panel to hidden without touching the
  // underlying toggle, so turning zen back off restores exactly what was shown.
  const effectiveSidebarVisible = sidebarVisible && !zen;

  const sidebarRef = usePanelRef();
  const editorRef = usePanelRef();

  // The sidebar panel's live width in px (null until first measured). The drag
  // divider is gated on this, not just the stored `sidebar` intent: if the panel
  // ends up collapsed (0px) while the store still says visible, showing the
  // separator would put a resize cursor over the empty left edge with nothing to
  // resize. Gating on the real width can only ever HIDE a divider that has no
  // panel behind it — it can't affect a genuinely open panel's resizing.
  const [sidebarPx, setSidebarPx] = useState<number | null>(null);

  useLayoutShortcuts();
  // The Sessions rail is now a side-panel view, so its load + auto-continue
  // effects live here (always mounted), not in the panel itself.
  useSessionBootstrap();

  // Seed the launch workspace on first run so the tab bar is never empty, and
  // load the IDE's own settings once so the editor reflects them from the start.
  useEffect(() => {
    void useWorkspaces.getState().bootstrap();
    void useSettings.getState().load();
  }, []);

  // Reconcile each collapsible panel to the store's visibility intent. collapse()/
  // expand() are no-ops when already in the target state, so this is safe on
  // every change (and on mount, to honour persisted visibility).
  useEffect(() => {
    sidebarRef.current?.[effectiveSidebarVisible ? "expand" : "collapse"]();
  }, [effectiveSidebarVisible, sidebarRef]);
  useEffect(() => {
    editorRef.current?.[editorVisible ? "expand" : "collapse"]();
  }, [editorVisible, editorRef]);

  // Whole-app zoom (§S3): a CSS `zoom` factor on the document root. WebKitGTK
  // (this app's target) supports the non-standard `zoom` property; set via
  // `setProperty` since it isn't in the standard CSSStyleDeclaration typing.
  const uiLevel = useZoom((s) => s.uiLevel);
  useEffect(() => {
    document.documentElement.style.setProperty("zoom", String(uiZoomFactor(uiLevel)));
  }, [uiLevel]);

  // `appearance.reducedMotion` (Addendum II §S6): an explicit override that
  // forces the same `global.css` reduced-motion rules the OS preference already
  // triggers, regardless of what the OS is set to.
  const cwd = useActiveCwd();
  const userAppearance = useSettings((s) => s.user.appearance);
  const wsAppearance = useSettings((s) => s.workspaces[cwd ?? ""]?.appearance);
  const reducedMotion = mergeEffectiveAppearance(userAppearance, wsAppearance).reducedMotion;
  useEffect(() => {
    if (reducedMotion) document.documentElement.dataset.reducedMotion = "true";
    else delete document.documentElement.dataset.reducedMotion;
  }, [reducedMotion]);

  // Sync a manual drag-to-collapse (or drag-open) back into the store so the
  // toggles reflect reality. The mount callback (prev === undefined) is skipped
  // so the store's persisted intent wins at startup; setVisible is a no-op when
  // unchanged, so the store-driven path above can't loop with this one.
  const syncFromDrag =
    (region: Region) =>
    (size: { inPixels: number }, _id: unknown, prev: unknown) => {
      // Track the real sidebar width on every resize (including the mount
      // measurement and programmatic collapse/expand) so the divider gate below
      // reflects reality, not just stored intent.
      if (region === "sidebar") setSidebarPx(size.inPixels);
      if (prev === undefined) return;
      // Zen mode drives the sidebar panel via collapse()/expand() without
      // touching the stored toggle (so turning zen off restores exactly what
      // was showing) — a resize caused by that must not sync back and clobber it.
      if (zen) return;
      setVisible(region, size.inPixels > 0);
    };

  return (
    <div className="flex h-full w-full flex-col">
      <TabBar />
      <main className="flex min-h-0 flex-1 flex-row overflow-hidden">
        {!zen && <ActivityBar />}
        {/* The panels Group gets a stable, flex-sized wrapper and fills it at
            width:100% — measuring a flex-item Group directly can oscillate into a
            ResizeObserver loop (which also thrashes Monaco's automaticLayout). */}
        <div className="min-w-0 flex-1" style={{ height: "100%" }}>
          <Group
            orientation="horizontal"
            defaultLayout={layout.defaultLayout}
            onLayoutChanged={layout.onLayoutChanged}
            style={{ height: "100%", width: "100%" }}
          >
          <Panel
            id="sidebar"
            defaultSize="260px"
            minSize="160px"
            maxSize="40%"
            collapsible
            collapsedSize={0}
            panelRef={sidebarRef}
            onResize={syncFromDrag("sidebar")}
            groupResizeBehavior="preserve-pixel-size"
            style={PANEL}
          >
            <SidePanel />
          </Panel>
          {effectiveSidebarVisible && (sidebarPx === null || sidebarPx > 0) && (
            <ResizeSeparator orientation="horizontal" />
          )}
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
        </div>
      </main>
      <BottomPanel />
      {!zen && <StatusBar />}
      <CommandPalette />
      <QuickOpen />
      <CheatSheet />
    </div>
  );
}

function TabBar() {
  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeId = useWorkspaces((s) => s.activeId);
  const activate = useWorkspaces((s) => s.activate);
  const close = useWorkspaces((s) => s.close);
  const streaming = useActiveConversation((s) => s.streaming);

  const openFolder = useCallback(async () => {
    const path = await pickFolder();
    if (path) useWorkspaces.getState().add(path);
  }, []);

  return (
    <div
      className="flex shrink-0 items-center justify-between gap-[var(--space-3)]"
      style={{
        height: "var(--space-7)",
        padding: "0 var(--space-3) 0 var(--space-3)",
        background: "var(--color-bg-recessed)",
        borderBottom: "1px solid var(--color-border-subtle)",
      }}
    >
      <div className="flex min-w-0 items-center gap-[var(--space-2)]">
        <span
          className={streaming ? "status-lamp-pulse" : undefined}
          aria-hidden="true"
          title={streaming ? "Agent running" : "Idle"}
          style={{
            flexShrink: 0,
            marginLeft: "var(--space-1)",
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            background: streaming ? "var(--color-status-running)" : "var(--color-status-idle)",
          }}
        />
        <div role="tablist" aria-label="Workspaces" className="flex min-w-0 items-center gap-[2px]">
          {workspaces.map((w) => (
            <WorkspaceTab
              key={w.id}
              ws={w}
              active={w.id === activeId}
              canClose={workspaces.length > 1}
              onActivate={() => activate(w.id)}
              onClose={() => close(w.id)}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => void openFolder()}
          aria-label="Open folder"
          title="Open Folder…"
          className="flex shrink-0 cursor-pointer items-center justify-center"
          style={{
            width: "var(--space-6)",
            height: "var(--space-6)",
            border: "none",
            borderRadius: "var(--radius-sm)",
            background: "transparent",
            color: "var(--color-fg-muted)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-sm)",
            lineHeight: 1,
          }}
        >
          +
        </button>
      </div>
      <PanelToggles />
    </div>
  );
}

function WorkspaceTab({
  ws,
  active,
  canClose,
  onActivate,
  onClose,
}: {
  ws: Workspace;
  active: boolean;
  canClose: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      className="group flex min-w-0 cursor-pointer items-center gap-[var(--space-2)]"
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
      title={ws.path}
      style={{
        height: "calc(var(--space-7) - var(--space-2))",
        maxWidth: "180px",
        padding: "0 var(--space-2) 0 var(--space-3)",
        borderRadius: "var(--radius-sm)",
        background: active ? "var(--color-bg-raised)" : "transparent",
        color: active ? "var(--color-fg-primary)" : "var(--color-fg-secondary)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {ws.name}
      </span>
      {canClose && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label={`Close ${ws.name}`}
          title={`Close ${ws.name}`}
          className="flex shrink-0 cursor-pointer items-center justify-center"
          style={{
            width: "16px",
            height: "16px",
            border: "none",
            borderRadius: "var(--radius-sm)",
            background: "transparent",
            color: "var(--color-fg-muted)",
            fontSize: "12px",
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

// Top-bar dock toggles for the hideable regions. The conversation hero is the
// center of gravity and has no toggle. Active = region visible.
function PanelToggles() {
  const sidebar = useLayout((s) => s.sidebar);
  const editor = useLayout((s) => s.editor);
  const terminal = useLayout((s) => s.terminal);
  const toggle = useLayout((s) => s.toggle);

  return (
    <div role="group" aria-label="Toggle panels" className="flex items-center gap-[var(--space-1)]">
      <ToggleButton glyph="◧" label="Side panel" shortcut="Ctrl+B" active={sidebar} onClick={() => toggle("sidebar")} />
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
