/*
 * Left sidebar (spec 5.A.3, Phase 4). A small VS Code-style view switcher over
 * the resizable left panel: Files (the explorer) and Source Control (git). The
 * Source Control tab shows a live change count. Global Search becomes a third
 * view in its own slice. Each view fills the panel; only the active one mounts.
 */

import { useEffect, useState } from "react";
import { FileExplorer } from "@/layout/FileExplorer";
import { GitPanel } from "@/layout/GitPanel";
import { useGit } from "@/store/git";

type View = "files" | "git";

export function Sidebar() {
  const [view, setView] = useState<View>("files");
  const changeCount = useGit((s) => s.status?.changes.length ?? 0);

  // Populate the source-control badge at startup, even before the view is opened.
  useEffect(() => {
    void useGit.getState().refresh();
  }, []);

  return (
    <aside className="flex h-full flex-col" style={{ background: "var(--color-bg-raised)" }}>
      <div
        role="tablist"
        aria-label="Sidebar views"
        className="flex shrink-0"
        style={{
          height: "var(--space-7)",
          borderBottom: "1px solid var(--color-border-subtle)",
        }}
      >
        <Tab label="Files" active={view === "files"} onClick={() => setView("files")} />
        <Tab
          label="Source Control"
          badge={changeCount || undefined}
          active={view === "git"}
          onClick={() => setView("git")}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {view === "files" ? <FileExplorer /> : <GitPanel />}
      </div>
    </aside>
  );
}

function Tab({
  label,
  badge,
  active,
  onClick,
}: {
  label: string;
  badge?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className="flex flex-1 cursor-pointer items-center justify-center gap-[var(--space-2)]"
      style={{
        border: "none",
        background: "transparent",
        borderBottom: active ? "2px solid var(--color-accent)" : "2px solid transparent",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        letterSpacing: "0.03em",
        color: active ? "var(--color-fg-primary)" : "var(--color-fg-secondary)",
      }}
    >
      {label}
      {badge ? (
        <span
          style={{
            minWidth: "16px",
            padding: "0 4px",
            borderRadius: "999px",
            background: "var(--color-accent-quiet)",
            color: "var(--color-fg-primary)",
            fontSize: "10px",
            lineHeight: "16px",
            textAlign: "center",
          }}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}
