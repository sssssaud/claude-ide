/*
 * Activity bar (Addendum II layout pass — VS Code-style). The always-visible
 * vertical icon strip on the far left of the app. It switches the side panel's
 * view — Files, Search, Source Control (live change badge), Permissions, Usage,
 * Sessions — and clicking the active view's icon collapses the panel (the strip
 * stays). A Settings cog pinned to the bottom opens Settings as an editor tab.
 *
 * The strip itself never hides; only its content panel (`SidePanel`) collapses,
 * so the views are always one click away. View selection lives in the layout
 * store so the strip and the panel stay in sync.
 */

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useGit } from "@/store/git";
import { activeEditorStore, useActiveEditor, SETTINGS_TAB_ID } from "@/store/editor";
import { useLayout, type View } from "@/store/layout";
import { useActiveCwd } from "@/store/workspaces";

const VIEWS: { id: View; label: string; icon: ReactNode }[] = [
  { id: "files", label: "Files", icon: <FilesIcon /> },
  { id: "search", label: "Search", icon: <SearchIcon /> },
  { id: "git", label: "Source Control", icon: <GitIcon /> },
  { id: "sessions", label: "Sessions", icon: <SessionsIcon /> },
  { id: "permissions", label: "Permissions", icon: <ShieldIcon /> },
  { id: "usage", label: "Usage", icon: <ChartIcon /> },
];

export function ActivityBar() {
  const view = useLayout((s) => s.view);
  const sidebarOpen = useLayout((s) => s.sidebar);
  const selectView = useLayout((s) => s.selectView);
  const changeCount = useGit((s) => s.status?.changes.length ?? 0);
  const settingsActive = useActiveEditor((s) => s.activePath === SETTINGS_TAB_ID);
  const cwd = useActiveCwd();
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Keep the Source-Control badge live as the active workspace changes. Lives
  // here (always mounted) so the badge is correct even when the panel is closed.
  useEffect(() => {
    void useGit.getState().refresh();
  }, [cwd]);

  // Roving tabindex (WAI-ARIA tabs): the selected view is the only tab stop;
  // Up/Down wrap, Home/End jump to the ends — moving focus AND selection together.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const idx = VIEWS.findIndex((v) => v.id === view);
    let next = idx;
    if (e.key === "ArrowDown") next = (idx + 1) % VIEWS.length;
    else if (e.key === "ArrowUp") next = (idx - 1 + VIEWS.length) % VIEWS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = VIEWS.length - 1;
    else return;
    e.preventDefault();
    selectView(VIEWS[next].id);
    btnRefs.current[next]?.focus();
  };

  const openSettings = () => {
    useLayout.getState().setVisible("editor", true);
    activeEditorStore().getState().openSettings();
  };

  return (
    <div
      className="flex h-full shrink-0 flex-col"
      style={{
        width: "var(--space-8)",
        background: "var(--color-bg-recessed)",
        borderRight: "1px solid var(--color-border-subtle)",
        paddingTop: "var(--space-2)",
        paddingBottom: "var(--space-2)",
      }}
    >
      <ActionButton
        label={sidebarOpen ? "Hide side panel (Ctrl+B)" : "Show side panel (Ctrl+B)"}
        icon={<ChevronIcon open={sidebarOpen} />}
        active={false}
        onClick={() => useLayout.getState().toggle("sidebar")}
      />
      <nav
        role="tablist"
        aria-label="Activity bar"
        aria-orientation="vertical"
        onKeyDown={onKeyDown}
        className="flex flex-col"
      >
        {VIEWS.map((v, i) => (
          <ActivityButton
            key={v.id}
            label={v.label}
            icon={v.icon}
            selected={view === v.id}
            active={view === v.id && sidebarOpen}
            badge={v.id === "git" ? changeCount || undefined : undefined}
            onClick={() => selectView(v.id)}
            buttonRef={(el) => {
              btnRefs.current[i] = el;
            }}
          />
        ))}
      </nav>
      <div style={{ marginTop: "auto" }}>
        <ActionButton label="Settings (Ctrl+,)" icon={<GearIcon />} active={settingsActive} onClick={openSettings} />
      </div>
    </div>
  );
}

function ActivityButton({
  label,
  icon,
  selected,
  active,
  badge,
  onClick,
  buttonRef,
}: {
  label: string;
  icon: ReactNode;
  /** The current view (drives roving tabindex + the accent when the panel is open). */
  selected: boolean;
  /** Selected AND the panel is open — shows the accent bar. */
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
      aria-selected={selected}
      aria-controls="side-panel"
      aria-label={label}
      title={label}
      tabIndex={selected ? 0 : -1}
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

// A non-tab activity-bar action (Settings) — same footprint as a tab, but an
// ordinary toggle button (not part of the roving-tabindex tablist).
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

function ChevronIcon({ open }: { open: boolean }) {
  // Points left to collapse the panel, right to reveal it.
  return (
    <svg {...svgProps()}>
      {open ? <path d="M11 4L6 9l5 5" /> : <path d="M7 4l5 5-5 5" />}
    </svg>
  );
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

function SessionsIcon() {
  // A timeline: nodes down a rail (matches the Sessions rail's visual language).
  return (
    <svg {...svgProps()}>
      <circle cx="5" cy="4" r="1.6" />
      <circle cx="5" cy="9" r="1.6" />
      <circle cx="5" cy="14" r="1.6" />
      <path d="M5 5.6v1.8M5 10.6v1.8" />
      <path d="M9 4h5M9 9h5M9 14h5" />
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
  // A proper cog (Lucide "settings"); own viewBox 24 so the path reads cleanly.
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
