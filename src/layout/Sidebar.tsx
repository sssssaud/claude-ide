/*
 * Left sidebar (spec 5.A.3). A VS Code-style **vertical icon activity bar** down
 * the far edge switches between the workspace views — Files, Search, Source
 * Control (live change badge), Permissions, Usage — and the chosen view fills the
 * rest of the panel. Phase 10 replaced the old cramped horizontal text-tab row
 * with this icon bar so the switcher scales without crowding. Each view fills the
 * panel; only the active one mounts.
 */

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { FileExplorer } from "@/layout/FileExplorer";
import { GitPanel } from "@/layout/GitPanel";
import { PermissionsPanel } from "@/layout/PermissionsPanel";
import { SearchPanel } from "@/layout/SearchPanel";
import { UsagePanel } from "@/layout/UsagePanel";
import { useGit } from "@/store/git";
import { useLayout } from "@/store/layout";
import { useActiveCwd } from "@/store/workspaces";

type View = "files" | "search" | "git" | "permissions" | "usage";

const VIEWS: { id: View; label: string; icon: ReactNode }[] = [
  { id: "files", label: "Files", icon: <FilesIcon /> },
  { id: "search", label: "Search", icon: <SearchIcon /> },
  { id: "git", label: "Source Control", icon: <GitIcon /> },
  { id: "permissions", label: "Permissions", icon: <ShieldIcon /> },
  { id: "usage", label: "Usage", icon: <ChartIcon /> },
];

export function Sidebar() {
  const [view, setView] = useState<View>("files");
  const changeCount = useGit((s) => s.status?.changes.length ?? 0);
  const cwd = useActiveCwd();
  const settingsOpen = useLayout((s) => s.settingsOpen);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Populate the source-control badge at startup, and re-read whenever the
  // active workspace changes so the badge + status track the open folder.
  useEffect(() => {
    void useGit.getState().refresh();
  }, [cwd]);

  // Roving tabindex (WAI-ARIA tabs): the active tab is the only tab stop;
  // Up/Down (vertical orientation) wrap through the tabs, Home/End jump to the
  // ends, each moving focus AND selection together.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const idx = VIEWS.findIndex((v) => v.id === view);
    let next = idx;
    if (e.key === "ArrowDown") next = (idx + 1) % VIEWS.length;
    else if (e.key === "ArrowUp") next = (idx - 1 + VIEWS.length) % VIEWS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = VIEWS.length - 1;
    else return;
    e.preventDefault();
    setView(VIEWS[next].id);
    btnRefs.current[next]?.focus();
  };

  return (
    <aside className="flex h-full flex-row" style={{ background: "var(--color-bg-raised)" }}>
      {/* Activity bar: the view tabs at the top, global actions (Settings) pinned
          to the bottom. Settings is an action, not a tab, so it sits outside the
          tablist and opens the full-area Settings overlay. */}
      <div
        className="flex shrink-0 flex-col"
        style={{
          width: "var(--space-8)",
          background: "var(--color-bg-recessed)",
          borderRight: "1px solid var(--color-border-subtle)",
          paddingTop: "var(--space-2)",
          paddingBottom: "var(--space-2)",
        }}
      >
        <nav
          role="tablist"
          aria-label="Sidebar views"
          aria-orientation="vertical"
          onKeyDown={onKeyDown}
          className="flex flex-col"
        >
          {VIEWS.map((v, i) => (
            <ActivityButton
              key={v.id}
              label={v.label}
              icon={v.icon}
              active={view === v.id}
              badge={v.id === "git" ? changeCount || undefined : undefined}
              onClick={() => setView(v.id)}
              buttonRef={(el) => {
                btnRefs.current[i] = el;
              }}
            />
          ))}
        </nav>
        <div style={{ marginTop: "auto" }}>
          <ActionButton
            label="Settings (Ctrl+,)"
            icon={<GearIcon />}
            active={settingsOpen}
            onClick={() => useLayout.getState().toggleSettings()}
          />
        </div>
      </div>
      <div
        id="sidebar-panel"
        role="tabpanel"
        aria-label={`${VIEWS.find((v) => v.id === view)?.label} view`}
        className="min-h-0 min-w-0 flex-1 overflow-hidden"
      >
        {view === "files" ? (
          <FileExplorer />
        ) : view === "search" ? (
          <SearchPanel />
        ) : view === "git" ? (
          <GitPanel />
        ) : view === "permissions" ? (
          <PermissionsPanel />
        ) : (
          <UsagePanel />
        )}
      </div>
    </aside>
  );
}

function ActivityButton({
  label,
  icon,
  active,
  badge,
  onClick,
  buttonRef,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  badge?: number;
  onClick: () => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      role="tab"
      aria-selected={active}
      aria-controls="sidebar-panel"
      aria-label={label}
      title={label}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      className="relative flex cursor-pointer items-center justify-center"
      style={{
        width: "var(--space-8)",
        height: "var(--space-8)",
        border: "none",
        background: "transparent",
        color: active ? "var(--color-fg-primary)" : "var(--color-fg-muted)",
        transition: `color var(--motion-fast) var(--ease-standard)`,
      }}
    >
      {/* Active indicator: accent bar on the inner edge (VS Code-style). */}
      {active && (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 0,
            top: "20%",
            bottom: "20%",
            width: "2px",
            background: "var(--color-accent)",
            borderRadius: "0 2px 2px 0",
          }}
        />
      )}
      {icon}
      {badge ? (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            right: "5px",
            bottom: "5px",
            minWidth: "14px",
            height: "14px",
            padding: "0 3px",
            borderRadius: "999px",
            background: "var(--color-accent)",
            color: "var(--color-bg-base)",
            fontFamily: "var(--font-mono)",
            fontSize: "9px",
            lineHeight: "14px",
            textAlign: "center",
            fontWeight: 600,
          }}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </button>
  );
}

// A non-tab activity-bar action (e.g. Settings) — same footprint as a tab, but
// an ordinary toggle button (not part of the roving-tabindex tablist).
function ActionButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className="relative flex cursor-pointer items-center justify-center"
      style={{
        width: "var(--space-8)",
        height: "var(--space-8)",
        border: "none",
        background: "transparent",
        color: active ? "var(--color-fg-primary)" : "var(--color-fg-muted)",
        transition: `color var(--motion-fast) var(--ease-standard)`,
      }}
    >
      {active && (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 0,
            top: "20%",
            bottom: "20%",
            width: "2px",
            background: "var(--color-accent)",
            borderRadius: "0 2px 2px 0",
          }}
        />
      )}
      {icon}
    </button>
  );
}

// ---- Icons (inline SVG, 18px, stroke = currentColor) ------------------------
// Small, crisp, theme-agnostic (they inherit the button's `color`).

function svgProps() {
  return {
    width: 18,
    height: 18,
    viewBox: "0 0 18 18",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
}

function FilesIcon() {
  return (
    <svg {...svgProps()}>
      <path d="M10 2H5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6z" />
      <path d="M10 2v4h4" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg {...svgProps()}>
      <circle cx="8" cy="8" r="5" />
      <path d="M11.5 11.5L15 15" />
    </svg>
  );
}

function GitIcon() {
  return (
    <svg {...svgProps()}>
      <circle cx="5" cy="4" r="2" />
      <circle cx="5" cy="14" r="2" />
      <circle cx="13" cy="6" r="2" />
      <path d="M5 6v6" />
      <path d="M13 8c0 3.5-3 2.5-5 4" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg {...svgProps()}>
      <path d="M9 2l5 2v5c0 3.4-2.4 5.9-5 7-2.6-1.1-5-3.6-5-7V4z" />
      <path d="M6.8 9l1.6 1.6L11.4 7.5" />
    </svg>
  );
}

function ChartIcon() {
  return (
    <svg {...svgProps()}>
      <path d="M3 15h12" />
      <path d="M5 15V9" />
      <path d="M9 15V4" />
      <path d="M13 15v-4" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg {...svgProps()}>
      <circle cx="9" cy="9" r="2.5" />
      <path d="M9 1.8v1.8M9 14.4v1.8M1.8 9h1.8M14.4 9h1.8M3.9 3.9l1.3 1.3M12.8 12.8l1.3 1.3M14.1 3.9l-1.3 1.3M5.2 12.8l-1.3 1.3" />
    </svg>
  );
}
