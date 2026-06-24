/*
 * Editor region (spec 5.A.3, 4.6). The file explorer beside the editor surface:
 * a tab strip over the Monaco host. The explorer▏code split is drag-resizable
 * (react-resizable-panels) with its own remembered width. Monaco stays OUT of
 * the initial bundle and unloaded until the first file is opened (idle memory
 * stays lean, spec 2.7); with no tabs open the code side shows the empty state
 * and the host isn't mounted.
 */

import type { CSSProperties } from "react";
import { lazy, Suspense } from "react";
import { Group, Panel, useDefaultLayout } from "react-resizable-panels";
import { EmptyState, LoadingState } from "@/components/states";
import { EditorTabs } from "@/layout/EditorTabs";
import { FileExplorer } from "@/layout/FileExplorer";
import { ResizeSeparator } from "@/layout/ResizeSeparator";
import { useEditor } from "@/store/editor";

// Lazy boundary keeps Monaco out of the initial chunk until a file opens.
const EditorPane = lazy(() =>
  import("@/layout/EditorPane").then((m) => ({ default: m.EditorPane })),
);

const PANEL: CSSProperties = { height: "100%", overflow: "hidden" };

export function EditorRegion() {
  const hasTabs = useEditor((s) => s.tabs.length > 0);
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
        <FileExplorer />
      </Panel>
      <ResizeSeparator orientation="horizontal" />
      <Panel id="code" minSize="280px" style={PANEL}>
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          {hasTabs ? (
            <>
              <EditorTabs />
              <div className="min-h-0 flex-1">
                <Suspense fallback={<LoadingState label="Loading editor…" />}>
                  <EditorPane />
                </Suspense>
              </div>
            </>
          ) : (
            <EmptyState
              title="No file open"
              hint="Pick a file from the explorer to view it. Monaco loads on demand."
            />
          )}
        </div>
      </Panel>
    </Group>
  );
}
