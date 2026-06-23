/*
 * Editor region (spec 5.A.3, 4.6). The file explorer beside the editor surface:
 * a tab strip over the Monaco host. Monaco stays OUT of the initial bundle and
 * unloaded until the first file is opened (idle memory stays lean, spec 2.7);
 * with no tabs open it shows the empty state and the host isn't mounted.
 */

import { lazy, Suspense } from "react";
import { EmptyState, LoadingState } from "@/components/states";
import { EditorTabs } from "@/layout/EditorTabs";
import { FileExplorer } from "@/layout/FileExplorer";
import { useEditor } from "@/store/editor";

// Lazy boundary keeps Monaco out of the initial chunk until a file opens.
const EditorPane = lazy(() =>
  import("@/layout/EditorPane").then((m) => ({ default: m.EditorPane })),
);

export function EditorRegion() {
  const hasTabs = useEditor((s) => s.tabs.length > 0);

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
        className="flex min-h-0 flex-col overflow-hidden"
        style={{ borderLeft: "1px solid var(--color-border-subtle)" }}
      >
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
    </div>
  );
}
