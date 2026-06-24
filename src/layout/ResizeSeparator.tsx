/*
 * A thin, styled drag handle between two resizable panels (react-resizable-panels
 * `Separator`). The visible line is 1px to match the app's panel borders; the
 * pointer hit area is widened to ~7px via a CSS `::after` so it's easy to grab,
 * and it tints with the accent colour on hover/drag. Double-click resets the
 * neighbouring panel to its default size (library behaviour). `orientation` is
 * the PARENT group's orientation: a "horizontal" group (columns) gets a vertical
 * divider you drag left/right; a "vertical" group gets a horizontal one.
 */

import { Separator } from "react-resizable-panels";

export function ResizeSeparator({ orientation }: { orientation: "horizontal" | "vertical" }) {
  const columns = orientation === "horizontal";
  return (
    <Separator
      className="resize-sep"
      data-axis={columns ? "x" : "y"}
      style={{
        position: "relative",
        background: "var(--color-border-subtle)",
        ...(columns ? { width: "1px" } : { height: "1px" }),
      }}
    />
  );
}
