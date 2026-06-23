/*
 * Editor region (spec 5.A.3, 4.6). The file explorer (always visible, cheap)
 * beside the Monaco pane. Monaco stays OUT of the initial bundle and unloaded
 * until a file is opened, so idle memory stays lean (spec 2.7) — opening a file
 * from the explorer lazy-mounts it. Multi-tab + save build on this next.
 */

import { lazy, Suspense } from "react";
import { EmptyState, LoadingState } from "@/components/states";
import { FileExplorer } from "@/layout/FileExplorer";
import { useEditor } from "@/store/editor";

// The lazy boundary keeps Monaco out of the initial chunk until a file opens.
const EditorPane = lazy(() =>
  import("@/layout/EditorPane").then((m) => ({ default: m.EditorPane })),
);

export function EditorRegion() {
  const openPath = useEditor((s) => s.openPath);

  return (
    <div
      className="grid h-full min-h-0"
      style={{
        gridTemplateColumns: "minmax(180px, 220px) minmax(0, 1fr)",
        gridTemplateRows: "minmax(0, 1fr)",
      }}
    >
      <FileExplorer />
      <div
        className="min-h-0 overflow-hidden"
        style={{ borderLeft: "1px solid var(--color-border-subtle)" }}
      >
        {openPath ? (
          <Suspense fallback={<LoadingState label="Loading editor…" />}>
            <EditorPane path={openPath} />
          </Suspense>
        ) : (
          <EmptyState
            title="No file open"
            hint="Pick a file from the explorer to view it. Monaco loads on demand."
          />
        )}
      </div>
    </div>
  );
}
