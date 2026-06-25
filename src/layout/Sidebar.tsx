/*
 * Left sidebar (spec 5.A.3, Phase 4). A small VS Code-style view switcher over
 * the resizable left panel: Files (the explorer) and Source Control (git). The
 * Source Control tab shows a live change count. Global Search becomes a third
 * view in its own slice. Each view fills the panel; only the active one mounts.
 */

import { useEffect, useState } from "react";
import { FileExplorer } from "@/layout/FileExplorer";
import { GitPanel } from "@/layout/GitPanel";
import { SearchPanel } from "@/layout/SearchPanel";
import { useGit } from "@/store/git";
import { useActiveCwd } from "@/store/workspaces";

type View = "files" | "git" | "search";

export function Sidebar() {
  const [view, setView] = useState<View>("files");
  const changeCount = useGit((s) => s.status?.changes.length ?? 0);
  const cwd = useActiveCwd();

  // Populate the source-control badge at startup, and re-read whenever the
  // active workspace changes so the badge + status track the open folder.
  useEffect(() => {
    void useGit.getState().refresh();
  }, [cwd]);

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
        <Tab label="Search" active={view === "search"} onClick={() => setView("search")} />
        <Tab
          label="Source Control"
          badge={changeCount || undefined}
          active={view === "git"}
          onClick={() => setView("git")}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {view === "files" ? <FileExplorer /> : view === "search" ? <SearchPanel /> : <GitPanel />}
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
      className="flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-[var(--space-1)]"
      style={{
        border: "none",
        background: "transparent",
        borderBottom: active ? "2px solid var(--color-accent)" : "2px solid transparent",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        letterSpacing: "0.02em",
        color: active ? "var(--color-fg-primary)" : "var(--color-fg-secondary)",
        padding: "0 var(--space-1)",
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
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
