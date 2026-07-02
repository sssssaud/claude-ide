/*
 * Dashboard view (P4 Usage, Phase 8 + Addendum III §S13 Memory). Two read-only
 * tabs over the workspace: Tokens, and Memory health.
 *
 * Tokens: EXACT — summed from the CLI's own transcripts (input / output /
 * cache-read / cache-write), per session and in total. Cost is deliberately an
 * ESTIMATE, not a fact: the CLI persists no cost on disk, and on a flat
 * subscription there is no per-token dollar charge at all. So the dollar figure
 * is computed here from EDITABLE per-million-token rates (your own assumption,
 * defaulted to Opus API list rates), and labelled as such — never a claim about
 * what you were actually billed.
 *
 * Memory: reports on Claude's own auto-memory system for this workspace
 * (`~/.claude/projects/<project>/memory/`) — line count vs. the 200-line cap,
 * topic files, staleness, duplicates — mirroring the `/si:status` skill.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { memoryHealth, workspaceUsage } from "@/ipc/commands";
import { isIpcError, type HealthBand, type MemoryHealth, type TokenSums, type UsageReport } from "@/ipc/types";
import { useActiveCwd } from "@/store/workspaces";

type UsageTab = "tokens" | "memory";
const TABS: { id: UsageTab; label: string }[] = [
  { id: "tokens", label: "TOKENS" },
  { id: "memory", label: "MEMORY" },
];

/** $/million-tokens. Defaults are Opus API list rates — edit to match your plan. */
interface Rates {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}
const DEFAULT_RATES: Rates = { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 };
const RATES_KEY = "ide:usage-rates";

function loadRates(): Rates {
  try {
    const raw = localStorage.getItem(RATES_KEY);
    if (!raw) return { ...DEFAULT_RATES };
    const v = JSON.parse(raw) as Partial<Rates>;
    return {
      input: num(v.input, DEFAULT_RATES.input),
      output: num(v.output, DEFAULT_RATES.output),
      cacheWrite: num(v.cacheWrite, DEFAULT_RATES.cacheWrite),
      cacheRead: num(v.cacheRead, DEFAULT_RATES.cacheRead),
    };
  } catch {
    return { ...DEFAULT_RATES };
  }
}
const num = (v: unknown, fallback: number) =>
  typeof v === "number" && isFinite(v) && v >= 0 ? v : fallback;

/** Estimated $ for a token bundle at the given rates. */
function estimate(t: TokenSums, r: Rates): number {
  return (
    (t.input * r.input +
      t.output * r.output +
      t.cacheCreation * r.cacheWrite +
      t.cacheRead * r.cacheRead) /
    1_000_000
  );
}

export function UsagePanel() {
  const [tab, setTab] = useState<UsageTab>("tokens");
  return (
    <div className="flex h-full flex-col">
      <div
        role="tablist"
        aria-label="Usage panel tabs"
        className="flex shrink-0 items-center gap-[var(--space-1)]"
        style={{ padding: "var(--space-2) var(--space-4) 0", borderBottom: "1px solid var(--color-border-subtle)" }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className="cursor-pointer"
            style={{
              padding: "var(--space-1) var(--space-2) var(--space-2)",
              border: "none",
              borderBottom: tab === t.id ? "2px solid var(--color-accent)" : "2px solid transparent",
              background: "transparent",
              color: tab === t.id ? "var(--color-fg-primary)" : "var(--color-fg-muted)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">{tab === "tokens" ? <TokensTab /> : <MemoryTab />}</div>
    </div>
  );
}

function TokensTab() {
  const cwd = useActiveCwd();
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rates, setRates] = useState<Rates>(loadRates);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    let alive = true;
    workspaceUsage(cwd ?? undefined)
      .then((r) => alive && setReport(r))
      .catch((e) => alive && setError(isIpcError(e) ? e.message : "Could not load usage"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [cwd]);

  useEffect(() => load(), [load]);

  const setRate = (key: keyof Rates, value: number) =>
    setRates((r) => {
      const next = { ...r, [key]: value };
      try {
        localStorage.setItem(RATES_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable — rates just won't persist */
      }
      return next;
    });

  const totalEstimate = useMemo(
    () => (report ? estimate(report.totals, rates) : 0),
    [report, rates],
  );

  if (loading) return <Note text="Reading session transcripts…" />;
  if (error) return <Note text={error} tone="error" />;
  if (!report || report.sessionCount === 0)
    return <Note text="No sessions yet — usage appears once you've run a turn." />;

  const t = report.totals;
  return (
    <div className="flex h-full flex-col overflow-y-auto" style={{ padding: "var(--space-4)" }}>
      <div className="flex items-baseline justify-between" style={{ marginBottom: "var(--space-2)" }}>
        <div style={{ fontSize: "var(--text-sm)", color: "var(--color-fg-primary)" }}>Token usage</div>
        <button
          type="button"
          onClick={() => load()}
          className="cursor-pointer"
          style={{
            border: "none",
            background: "transparent",
            color: "var(--color-fg-secondary)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
          }}
        >
          ↻ reload
        </button>
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color: "var(--color-fg-muted)",
          marginBottom: "var(--space-3)",
        }}
      >
        {report.sessionCount} session{report.sessionCount === 1 ? "" : "s"} · {fmt(t.messages)}{" "}
        assistant messages
      </div>

      {/* Totals — exact tokens */}
      <Card>
        <CardTitle>Total tokens</CardTitle>
        <TokenGrid t={t} />
      </Card>

      {/* Cost estimate — editable, non-authoritative */}
      <Card>
        <CardTitle>Estimated cost</CardTitle>
        <div
          style={{
            fontSize: "var(--text-lg, 1.25rem)",
            color: "var(--color-fg-primary)",
            margin: "2px 0 var(--space-2)",
          }}
        >
          ~${totalEstimate.toFixed(2)}
        </div>
        <div className="flex flex-col gap-[var(--space-1)]" style={{ marginBottom: "var(--space-2)" }}>
          <RateInput label="Input $/Mtok" value={rates.input} onChange={(v) => setRate("input", v)} />
          <RateInput label="Output $/Mtok" value={rates.output} onChange={(v) => setRate("output", v)} />
          <RateInput
            label="Cache write $/Mtok"
            value={rates.cacheWrite}
            onChange={(v) => setRate("cacheWrite", v)}
          />
          <RateInput
            label="Cache read $/Mtok"
            value={rates.cacheRead}
            onChange={(v) => setRate("cacheRead", v)}
          />
        </div>
        <p style={{ fontSize: "var(--text-xs)", lineHeight: 1.5, color: "var(--color-fg-muted)" }}>
          Estimate only. Tokens are exact (from the transcripts); the rates above are your own
          assumption (defaulted to Opus API list prices). On a Claude subscription your billing is
          flat — this dollar figure is the API-equivalent, not what you paid.
        </p>
      </Card>

      {/* Per-session breakdown */}
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          letterSpacing: "0.04em",
          color: "var(--color-fg-secondary)",
          margin: "var(--space-2) 0 var(--space-1)",
        }}
      >
        BY SESSION
      </div>
      <ul className="flex flex-col gap-[var(--space-2)]">
        {report.rows.map((row) => (
          <li
            key={row.sessionId}
            style={{
              padding: "var(--space-2)",
              borderRadius: "var(--radius-sm)",
              background: "var(--color-bg-base)",
              border: "1px solid var(--color-border-subtle)",
            }}
          >
            <div
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--color-fg-primary)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={row.label}
            >
              {row.label}
            </div>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                color: "var(--color-fg-muted)",
                margin: "2px 0 var(--space-1)",
              }}
            >
              {(row.models.join(", ") || "—")} · {relativeTime(row.lastActiveMs)} · ~$
              {estimate(row.tokens, rates).toFixed(2)}
            </div>
            <TokenGrid t={row.tokens} compact />
          </li>
        ))}
      </ul>
    </div>
  );
}

const BAND_COLOR: Record<HealthBand, string> = {
  healthy: "var(--color-status-success)",
  warning: "var(--color-status-awaiting)",
  critical: "var(--color-status-danger)",
};
const BAND_LABEL: Record<HealthBand, string> = {
  healthy: "Healthy",
  warning: "Warning",
  critical: "Critical",
};

function MemoryTab() {
  const cwd = useActiveCwd();
  const [health, setHealth] = useState<MemoryHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    let alive = true;
    memoryHealth(cwd ?? undefined)
      .then((h) => alive && setHealth(h))
      .catch((e) => alive && setError(isIpcError(e) ? e.message : "Could not read memory health"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [cwd]);

  useEffect(() => load(), [load]);

  if (loading) return <Note text="Reading memory files…" />;
  if (error) return <Note text={error} tone="error" />;
  if (!health || !health.projectFound)
    return <Note text="No Claude session recorded for this workspace yet — memory appears once you've had a conversation here." />;
  if (!health.memoryDirExists)
    return <Note text="No auto-memory written for this project yet." />;

  const pct = Math.min(100, Math.round((health.memoryMdLines / health.memoryMdCap) * 100));

  return (
    <div className="flex h-full flex-col overflow-y-auto" style={{ padding: "var(--space-4)" }}>
      <div className="flex items-baseline justify-between" style={{ marginBottom: "var(--space-3)" }}>
        <div className="flex items-center gap-[var(--space-2)]">
          <div style={{ fontSize: "var(--text-sm)", color: "var(--color-fg-primary)" }}>Memory health</div>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: BAND_COLOR[health.capacity],
              border: `1px solid ${BAND_COLOR[health.capacity]}`,
              borderRadius: "var(--radius-sm)",
              padding: "0 var(--space-1)",
            }}
          >
            {BAND_LABEL[health.capacity]}
          </span>
        </div>
        <button
          type="button"
          onClick={() => load()}
          className="cursor-pointer"
          style={{
            border: "none",
            background: "transparent",
            color: "var(--color-fg-secondary)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
          }}
        >
          ↻ reload
        </button>
      </div>

      <Card>
        <CardTitle>MEMORY.md</CardTitle>
        <div className="flex items-baseline justify-between" style={{ marginBottom: "var(--space-1)" }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", color: "var(--color-fg-primary)" }}>
            {health.memoryMdLines} / {health.memoryMdCap} lines
          </span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--color-fg-muted)" }}>
            {health.memoryMdUpdatedMs ? relativeTime(health.memoryMdUpdatedMs) : "never updated"}
          </span>
        </div>
        <div
          aria-hidden="true"
          style={{ height: "6px", borderRadius: "999px", background: "var(--color-bg-base)", overflow: "hidden" }}
        >
          <div style={{ height: "100%", width: `${pct}%`, background: BAND_COLOR[health.capacity] }} />
        </div>
      </Card>

      <Card>
        <CardTitle>TOPIC FILES ({health.topicFiles.length})</CardTitle>
        {health.topicFiles.length === 0 ? (
          <p style={{ fontSize: "var(--text-xs)", color: "var(--color-fg-muted)" }}>None yet.</p>
        ) : (
          <ul className="flex flex-col gap-[2px]">
            {health.topicFiles.map((f) => (
              <li
                key={f.name}
                className="flex items-center gap-[var(--space-2)]"
                style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}
              >
                <span
                  title={f.name}
                  className="min-w-0 flex-1"
                  style={{ color: "var(--color-fg-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {f.name}
                </span>
                <span className="shrink-0" style={{ color: "var(--color-fg-muted)" }}>
                  {f.lines} lines
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardTitle>PROJECT RULES</CardTitle>
        <TokenGridLike
          rows={[
            ["Project CLAUDE.md", health.projectClaudeMdLines != null ? `${health.projectClaudeMdLines} lines` : "none"],
            ["User CLAUDE.md", health.userClaudeMdLines != null ? `${health.userClaudeMdLines} lines` : "none"],
            [".claude/rules/", `${health.rulesFileCount} file${health.rulesFileCount === 1 ? "" : "s"}`],
          ]}
        />
      </Card>

      {(health.staleRefs.length > 0 || health.duplicateRefs.length > 0) && (
        <Card>
          <CardTitle>ISSUES</CardTitle>
          {health.staleRefs.length > 0 && (
            <p style={{ fontSize: "var(--text-xs)", color: "var(--color-status-danger)", marginBottom: "var(--space-1)" }}>
              Stale: {health.staleRefs.join(", ")}
            </p>
          )}
          {health.duplicateRefs.length > 0 && (
            <p style={{ fontSize: "var(--text-xs)", color: "var(--color-status-awaiting)" }}>
              Duplicated: {health.duplicateRefs.join(", ")}
            </p>
          )}
        </Card>
      )}

      {health.recommendations.length > 0 && (
        <Card>
          <CardTitle>RECOMMENDATIONS</CardTitle>
          <ul className="flex flex-col gap-[var(--space-1)]">
            {health.recommendations.map((r) => (
              <li key={r} style={{ fontSize: "var(--text-xs)", color: "var(--color-fg-secondary)", lineHeight: 1.5 }}>
                · {r}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function TokenGridLike({ rows }: { rows: [string, string][] }) {
  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: "1fr auto",
        gap: "2px var(--space-3)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
      }}
    >
      {rows.map(([label, value]) => (
        <Frag key={label}>
          <span style={{ color: "var(--color-fg-muted)" }}>{label}</span>
          <span style={{ color: "var(--color-fg-secondary)", textAlign: "right" }}>{value}</span>
        </Frag>
      ))}
    </div>
  );
}

/** A 2-column token readout (exact counts). */
function TokenGrid({ t, compact }: { t: TokenSums; compact?: boolean }) {
  const rows: [string, number][] = [
    ["Input", t.input],
    ["Output", t.output],
    ["Cache read", t.cacheRead],
    ["Cache write", t.cacheCreation],
  ];
  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: "1fr auto",
        gap: compact ? "0 var(--space-3)" : "2px var(--space-3)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
      }}
    >
      {rows.map(([label, value]) => (
        <Frag key={label}>
          <span style={{ color: "var(--color-fg-muted)" }}>{label}</span>
          <span style={{ color: "var(--color-fg-secondary)", textAlign: "right" }}>{fmt(value)}</span>
        </Frag>
      ))}
    </div>
  );
}

// A tiny fragment wrapper so the grid stays a flat 2-col layout.
function Frag({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function RateInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-[var(--space-2)]">
      <span
        style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--color-fg-muted)" }}
      >
        {label}
      </span>
      <input
        type="number"
        min={0}
        step="0.01"
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(num(parseFloat(e.target.value), 0))}
        className="text-right"
        style={{
          width: "72px",
          background: "var(--color-bg-raised)",
          border: "1px solid var(--color-border-subtle)",
          borderRadius: "var(--radius-sm)",
          padding: "1px var(--space-2)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color: "var(--color-fg-primary)",
        }}
      />
    </label>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: "var(--space-3)",
        marginBottom: "var(--space-3)",
        borderRadius: "var(--radius-sm)",
        background: "var(--color-bg-raised)",
        border: "1px solid var(--color-border-subtle)",
      }}
    >
      {children}
    </div>
  );
}

function CardTitle({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        letterSpacing: "0.04em",
        color: "var(--color-fg-secondary)",
        marginBottom: "var(--space-1)",
      }}
    >
      {children}
    </div>
  );
}

function Note({ text, tone }: { text: string; tone?: "error" }) {
  return (
    <p
      style={{
        padding: "var(--space-4)",
        fontSize: "var(--text-sm)",
        color: tone === "error" ? "var(--color-status-danger)" : "var(--color-fg-muted)",
        lineHeight: 1.5,
      }}
    >
      {text}
    </p>
  );
}

/** Compact token/count formatting: 1.23M, 45.6k, 789. */
function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function relativeTime(ms: number): string {
  if (!ms) return "";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
