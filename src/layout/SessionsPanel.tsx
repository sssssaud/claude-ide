/*
 * Sessions panel + Timeline Rail (spec 4.2 — the signature). Phase 0 renders
 * the rail's visual language (checkpoint nodes, a branch fork, a softly pulsing
 * active head) with dummy data. Real session resolution from the ~/.claude.json
 * registry and live `/branch` `/rewind` structure land in Phase 3.
 */

interface RailNode {
  id: string;
  label: string;
  meta: string;
  kind: "checkpoint" | "branch" | "active";
}

const DUMMY_NODES: RailNode[] = [
  { id: "n1", label: "Initial prompt", meta: "main · 3 msgs", kind: "checkpoint" },
  { id: "n2", label: "Add parser", meta: "main · 11 msgs", kind: "checkpoint" },
  { id: "n3", label: "Try alt approach", meta: "branch · fork", kind: "branch" },
  { id: "n4", label: "Current turn", meta: "running…", kind: "active" },
];

export function SessionsPanel() {
  return (
    <aside
      className="flex h-full flex-col"
      style={{
        background: "var(--color-bg-raised)",
        borderRight: "1px solid var(--color-border-subtle)",
      }}
    >
      <PanelHeader label="SESSIONS" />
      <div className="min-h-0 flex-1 overflow-y-auto" style={{ padding: "var(--space-4)" }}>
        <ol className="flex flex-col">
          {DUMMY_NODES.map((node, i) => (
            <RailItem key={node.id} node={node} last={i === DUMMY_NODES.length - 1} />
          ))}
        </ol>
      </div>
    </aside>
  );
}

function RailItem({ node, last }: { node: RailNode; last: boolean }) {
  const isActive = node.kind === "active";
  const isBranch = node.kind === "branch";
  const dotColor = isActive
    ? "var(--color-status-running)"
    : isBranch
      ? "var(--color-status-info)"
      : "var(--color-fg-secondary)";

  return (
    <li className="flex gap-[var(--space-4)]" style={{ minHeight: "var(--space-8)" }}>
      {/* Rail column: connector line + node dot */}
      <div className="relative flex w-[14px] shrink-0 flex-col items-center">
        <span
          className={isActive ? "status-lamp-pulse" : undefined}
          style={{
            width: "10px",
            height: "10px",
            marginTop: "2px",
            borderRadius: "50%",
            background: dotColor,
            boxShadow: isBranch ? "0 0 0 3px var(--color-bg-raised)" : undefined,
            zIndex: 1,
          }}
          aria-hidden="true"
        />
        {!last && (
          <span
            style={{
              flex: 1,
              width: "2px",
              marginTop: "2px",
              background: "var(--color-border-strong)",
            }}
            aria-hidden="true"
          />
        )}
      </div>
      {/* Node content */}
      <div style={{ paddingBottom: "var(--space-5)" }}>
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--color-fg-primary)",
            marginLeft: isBranch ? "var(--space-3)" : 0,
          }}
        >
          {node.label}
        </div>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: isActive ? "var(--color-status-running)" : "var(--color-fg-muted)",
            marginLeft: isBranch ? "var(--space-3)" : 0,
          }}
        >
          {node.meta}
        </div>
      </div>
    </li>
  );
}

function PanelHeader({ label }: { label: string }) {
  return (
    <div
      className="flex shrink-0 items-center"
      style={{
        height: "var(--space-7)",
        padding: "0 var(--space-4)",
        borderBottom: "1px solid var(--color-border-subtle)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        letterSpacing: "0.04em",
        color: "var(--color-fg-secondary)",
      }}
    >
      {label}
    </div>
  );
}
