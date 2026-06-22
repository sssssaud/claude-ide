/*
 * Editor region (spec 5.A.3, 4.6). A lightweight, non-lazy gate around the
 * heavy Monaco pane: at idle it shows the editor's empty state and Monaco is
 * NOT loaded, so idle memory stays lean (spec 2.7). Monaco's chunk loads only
 * when a buffer is opened. The full file explorer / multi-tab open flow lands
 * in Phase 4; here a scratch buffer demonstrates on-demand mount + dispose.
 */

import { lazy, Suspense, useState } from "react";
import { AppButton, EmptyState, LoadingState } from "@/components/states";

// The lazy boundary must live OUTSIDE this component so Monaco stays out of the
// initial bundle AND unloaded until `open` flips true.
const EditorPane = lazy(() =>
  import("@/layout/EditorPane").then((m) => ({ default: m.EditorPane })),
);

export function EditorRegion() {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <EmptyState
        title="No file open"
        hint="The Monaco editor loads on demand, so idle memory stays lean until you need it. (File explorer + open arrives in Phase 4.)"
        action={
          <AppButton onClick={() => setOpen(true)}>Open scratch buffer</AppButton>
        }
      />
    );
  }

  return (
    <Suspense fallback={<LoadingState label="Loading editor…" />}>
      <EditorPane onClose={() => setOpen(false)} />
    </Suspense>
  );
}
