/*
 * Permissions view (spec 3.6, Phase 7 7B — P3 permission manager). A structured
 * editor over the project's SHARED `.claude/settings.json` permissions block:
 * the allow / ask / deny rule lists (shown in precedence order), the default
 * mode, and additional tool-access directories. Save writes the file the
 * installed `claude` CLI itself reads, preserving every other key.
 *
 * The "Will this prompt?" panel is a TRANSPARENT PREVIEW, not an oracle: it
 * evaluates the on-screen rules using the documented precedence (deny ▸ ask ▸
 * allow) and a deliberately loose, clearly-labelled matcher. The CLI is the real
 * authority — it merges local/user/managed scopes and its exact matching can
 * differ — so this never claims to be a security guarantee.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { readPermissions, writePermissions } from "@/ipc/commands";
import { isIpcError, type PermissionMode, type ProjectPermissions } from "@/ipc/types";
import { useActiveCwd } from "@/store/workspaces";

const EMPTY: ProjectPermissions = {
  allow: [],
  ask: [],
  deny: [],
  defaultMode: undefined,
  additionalDirectories: [],
};

const MODES: { value: "" | PermissionMode; label: string }[] = [
  { value: "", label: "Unset (CLI default)" },
  { value: "default", label: "default — ask per tool" },
  { value: "acceptEdits", label: "acceptEdits — auto-accept edits" },
  { value: "plan", label: "plan — read-only, no changes" },
  { value: "bypassPermissions", label: "bypassPermissions — allow all" },
];

type RuleKey = "deny" | "ask" | "allow";

export function PermissionsPanel() {
  const cwd = useActiveCwd();
  const [draft, setDraft] = useState<ProjectPermissions>(EMPTY);
  const [saved, setSaved] = useState<ProjectPermissions>(EMPTY);
  const [exists, setExists] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    setStatus(null);
    let alive = true;
    readPermissions(cwd ?? undefined)
      .then((f) => {
        if (!alive) return;
        setDraft(f.permissions);
        setSaved(f.permissions);
        setExists(f.exists);
      })
      .catch((e) => alive && setError(isIpcError(e) ? e.message : "Could not load permissions"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [cwd]);

  useEffect(() => load(), [load]);

  const dirty = useMemo(() => !samePermissions(draft, saved), [draft, saved]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      await writePermissions(draft, cwd ?? undefined);
      setSaved(draft);
      setExists(true);
      setStatus("Saved to .claude/settings.json");
    } catch (e) {
      setError(isIpcError(e) ? e.message : "Could not save permissions");
    } finally {
      setSaving(false);
    }
  }, [draft, cwd]);

  const addRule = (key: RuleKey | "additionalDirectories", value: string) => {
    const v = value.trim();
    if (!v) return;
    setDraft((d) => (d[key].includes(v) ? d : { ...d, [key]: [...d[key], v] }));
  };
  const removeRule = (key: RuleKey | "additionalDirectories", value: string) =>
    setDraft((d) => ({ ...d, [key]: d[key].filter((r) => r !== value) }));

  if (loading) return <Note text="Loading permissions…" />;

  return (
    <div className="flex h-full flex-col overflow-y-auto" style={{ padding: "var(--space-4)" }}>
      <div style={{ marginBottom: "var(--space-3)" }}>
        <div style={{ fontSize: "var(--text-sm)", color: "var(--color-fg-primary)" }}>
          Project permissions
        </div>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--color-fg-muted)",
            marginTop: "2px",
          }}
        >
          .claude/settings.json {exists ? "· shared, committed" : "· not created yet — Save creates it"}
        </div>
      </div>

      {error && <Note text={error} tone="error" />}

      {/* Default mode */}
      <Field label="Default mode">
        <select
          value={draft.defaultMode ?? ""}
          onChange={(e) =>
            setDraft((d) => ({
              ...d,
              defaultMode: e.target.value ? (e.target.value as PermissionMode) : undefined,
            }))
          }
          className="w-full cursor-pointer"
          style={selectStyle}
        >
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>

      {/* Precedence legend */}
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color: "var(--color-fg-muted)",
          margin: "var(--space-2) 0",
        }}
      >
        precedence: <span style={{ color: "var(--color-status-danger)" }}>deny</span> ▸{" "}
        <span style={{ color: "var(--color-status-warning, var(--color-accent))" }}>ask</span> ▸{" "}
        <span style={{ color: "var(--color-status-success)" }}>allow</span>
      </div>

      <RuleList
        title="Deny"
        tone="danger"
        rules={draft.deny}
        placeholder="Bash(curl:*)"
        onAdd={(v) => addRule("deny", v)}
        onRemove={(v) => removeRule("deny", v)}
      />
      <RuleList
        title="Ask"
        tone="accent"
        rules={draft.ask}
        placeholder="Bash(git push:*)"
        onAdd={(v) => addRule("ask", v)}
        onRemove={(v) => removeRule("ask", v)}
      />
      <RuleList
        title="Allow"
        tone="success"
        rules={draft.allow}
        placeholder="Bash(npm run test:*)"
        onAdd={(v) => addRule("allow", v)}
        onRemove={(v) => removeRule("allow", v)}
      />
      <RuleList
        title="Additional directories"
        tone="muted"
        rules={draft.additionalDirectories}
        placeholder="../shared-lib"
        onAdd={(v) => addRule("additionalDirectories", v)}
        onRemove={(v) => removeRule("additionalDirectories", v)}
      />

      {/* Save row */}
      <div
        className="flex items-center gap-[var(--space-2)]"
        style={{ margin: "var(--space-3) 0", flexWrap: "wrap" }}
      >
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || saving}
          className={dirty && !saving ? "cursor-pointer" : ""}
          style={{
            ...btnStyle,
            background: dirty && !saving ? "var(--color-accent)" : "var(--color-bg-raised)",
            color: dirty && !saving ? "var(--color-bg-base)" : "var(--color-fg-muted)",
            opacity: dirty && !saving ? 1 : 0.6,
          }}
        >
          {saving ? "Saving…" : dirty ? "● Save" : "Saved"}
        </button>
        <button
          type="button"
          onClick={() => load()}
          disabled={saving}
          className="cursor-pointer"
          style={{ ...btnStyle, background: "transparent", color: "var(--color-fg-secondary)" }}
        >
          Reload
        </button>
        {status && (
          <span style={{ fontSize: "var(--text-xs)", color: "var(--color-status-success)" }}>
            {status}
          </span>
        )}
      </div>

      <Tester permissions={draft} />
    </div>
  );
}

/** A single rule list (one of deny/ask/allow/additionalDirectories). */
function RuleList({
  title,
  tone,
  rules,
  placeholder,
  onAdd,
  onRemove,
}: {
  title: string;
  tone: "danger" | "accent" | "success" | "muted";
  rules: string[];
  placeholder: string;
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  const color =
    tone === "danger"
      ? "var(--color-status-danger)"
      : tone === "success"
        ? "var(--color-status-success)"
        : tone === "accent"
          ? "var(--color-accent)"
          : "var(--color-fg-secondary)";

  const submit = () => {
    onAdd(value);
    setValue("");
  };

  return (
    <section style={{ marginBottom: "var(--space-3)" }}>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          letterSpacing: "0.04em",
          color,
          marginBottom: "var(--space-1)",
        }}
      >
        {title} ({rules.length})
      </div>
      {rules.length > 0 && (
        <ul className="flex flex-col gap-[2px]" style={{ marginBottom: "var(--space-1)" }}>
          {rules.map((rule) => (
            <li
              key={rule}
              className="group flex items-start gap-[var(--space-2)]"
              style={{
                padding: "2px var(--space-2)",
                borderRadius: "var(--radius-sm)",
                background: "var(--color-bg-base)",
                borderLeft: `2px solid ${color}`,
              }}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-xs)",
                  color: "var(--color-fg-secondary)",
                  wordBreak: "break-all",
                }}
              >
                {rule}
              </span>
              <button
                type="button"
                onClick={() => onRemove(rule)}
                aria-label={`Remove ${rule}`}
                title="Remove"
                className="shrink-0 cursor-pointer"
                style={{
                  border: "none",
                  background: "transparent",
                  color: "var(--color-fg-muted)",
                  fontSize: "var(--text-sm)",
                  lineHeight: 1,
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-[var(--space-1)]">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          spellCheck={false}
          className="min-w-0 flex-1"
          style={inputStyle}
        />
        <button
          type="button"
          onClick={submit}
          disabled={!value.trim()}
          className={value.trim() ? "cursor-pointer" : ""}
          style={{
            ...btnStyle,
            padding: "0 var(--space-2)",
            background: "var(--color-bg-raised)",
            color: value.trim() ? "var(--color-fg-primary)" : "var(--color-fg-muted)",
            opacity: value.trim() ? 1 : 0.6,
          }}
        >
          +
        </button>
      </div>
    </section>
  );
}

/** The transparent "Will this prompt?" preview (non-authoritative). */
function Tester({ permissions }: { permissions: ProjectPermissions }) {
  const [tool, setTool] = useState("");
  const [arg, setArg] = useState("");
  const result = useMemo(
    () => (tool.trim() ? evaluate(permissions, tool.trim(), arg) : null),
    [permissions, tool, arg],
  );

  const outcome = result?.outcome ?? "none";
  const outcomeColor =
    outcome === "deny"
      ? "var(--color-status-danger)"
      : outcome === "allow"
        ? "var(--color-status-success)"
        : outcome === "ask"
          ? "var(--color-accent)"
          : "var(--color-fg-muted)";

  return (
    <section
      style={{
        marginTop: "var(--space-2)",
        paddingTop: "var(--space-3)",
        borderTop: "1px solid var(--color-border-subtle)",
      }}
    >
      <div
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--color-fg-primary)",
          marginBottom: "var(--space-1)",
        }}
      >
        Will this prompt?
      </div>
      <Field label="Tool">
        <input
          value={tool}
          onChange={(e) => setTool(e.target.value)}
          placeholder="Bash"
          spellCheck={false}
          className="w-full"
          style={inputStyle}
        />
      </Field>
      <Field label="Argument / path / command">
        <input
          value={arg}
          onChange={(e) => setArg(e.target.value)}
          placeholder="rm -rf build"
          spellCheck={false}
          className="w-full"
          style={inputStyle}
        />
      </Field>

      {result && (
        <div style={{ marginTop: "var(--space-2)" }}>
          <div style={{ fontSize: "var(--text-sm)", color: outcomeColor }}>
            {result.label}
          </div>
          {result.matches.length > 0 ? (
            <ul
              className="flex flex-col gap-[2px]"
              style={{ marginTop: "var(--space-1)" }}
            >
              {result.matches.map((m, i) => (
                <li
                  key={`${m.list}:${m.rule}:${i}`}
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-xs)",
                    color: "var(--color-fg-muted)",
                    wordBreak: "break-all",
                  }}
                >
                  <span style={{ color: outcomeColorFor(m.list) }}>{m.list}</span> · {m.rule} (
                  {m.reason})
                </li>
              ))}
            </ul>
          ) : (
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                color: "var(--color-fg-muted)",
                marginTop: "var(--space-1)",
              }}
            >
              No rule matched — the CLI applies its default
              {permissions.defaultMode ? ` (mode: ${permissions.defaultMode})` : ""}.
            </div>
          )}
        </div>
      )}

      <p
        style={{
          marginTop: "var(--space-2)",
          fontSize: "var(--text-xs)",
          lineHeight: 1.5,
          color: "var(--color-fg-muted)",
        }}
      >
        Preview only — checks the rules shown above (deny ▸ ask ▸ allow) with a loose matcher.
        The installed <code>claude</code> CLI is the final authority: it also merges your local,
        user, and managed settings, and its exact matching can differ. Not a security guarantee.
      </p>
    </section>
  );
}

// ---- Transparent matcher (preview only; see the disclaimer above) -----------

type Outcome = "deny" | "ask" | "allow" | "none";
interface Match {
  list: "deny" | "ask" | "allow";
  rule: string;
  reason: string;
}
interface EvalResult {
  outcome: Outcome;
  label: string;
  matches: Match[];
}

/** Split `Tool(spec)` into its tool name and specifier (null = whole tool). */
function parseRule(rule: string): { tool: string; spec: string | null } {
  const open = rule.indexOf("(");
  if (open === -1 || !rule.endsWith(")")) return { tool: rule.trim(), spec: null };
  return { tool: rule.slice(0, open).trim(), spec: rule.slice(open + 1, -1) };
}

/** Loose, transparent glob → RegExp: `*`/`**` become "any chars", `?` one char.
 *  Deliberately a superset of the CLI's path-aware matcher (preview only). */
function specToRegExp(spec: string): RegExp {
  const escaped = spec.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const globbed = escaped.replace(/\*+/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${globbed}$`);
}

/** Does a rule match the tool+arg? Returns a human reason, or null. */
function ruleReason(rule: string, tool: string, arg: string): string | null {
  const p = parseRule(rule);
  if (p.tool !== tool) return null;
  if (p.spec === null) return "whole tool";
  if (p.spec === arg) return "exact";
  if (p.spec.includes("*") || p.spec.includes("?")) {
    try {
      if (specToRegExp(p.spec).test(arg)) return "pattern";
    } catch {
      /* malformed pattern — treat as no match */
    }
  }
  return null;
}

function matchList(rules: string[], list: Match["list"], tool: string, arg: string): Match[] {
  const out: Match[] = [];
  for (const rule of rules) {
    const reason = ruleReason(rule, tool, arg);
    if (reason) out.push({ list, rule, reason });
  }
  return out;
}

function evaluate(p: ProjectPermissions, tool: string, arg: string): EvalResult {
  const deny = matchList(p.deny, "deny", tool, arg);
  const ask = matchList(p.ask, "ask", tool, arg);
  const allow = matchList(p.allow, "allow", tool, arg);
  // Precedence: deny ▸ ask ▸ allow. Show every match, but the outcome is the
  // highest-precedence list that has one.
  if (deny.length) return { outcome: "deny", label: "Denied — blocked, won't run", matches: deny };
  if (ask.length) return { outcome: "ask", label: "Asks — you'll be prompted", matches: ask };
  if (allow.length)
    return { outcome: "allow", label: "Allowed — runs without a prompt", matches: allow };
  return { outcome: "none", label: "No matching rule", matches: [] };
}

function outcomeColorFor(list: Match["list"]): string {
  return list === "deny"
    ? "var(--color-status-danger)"
    : list === "allow"
      ? "var(--color-status-success)"
      : "var(--color-accent)";
}

// ---- Small shared bits ------------------------------------------------------

function samePermissions(a: ProjectPermissions, b: ProjectPermissions): boolean {
  return (
    a.defaultMode === b.defaultMode &&
    sameArr(a.allow, b.allow) &&
    sameArr(a.ask, b.ask) &&
    sameArr(a.deny, b.deny) &&
    sameArr(a.additionalDirectories, b.additionalDirectories)
  );
}
function sameArr(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col" style={{ marginBottom: "var(--space-2)", gap: "2px" }}>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color: "var(--color-fg-muted)",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

function Note({ text, tone }: { text: string; tone?: "error" }) {
  return (
    <p
      style={{
        padding: "var(--space-2) var(--space-4)",
        fontSize: "var(--text-sm)",
        color: tone === "error" ? "var(--color-status-danger)" : "var(--color-fg-muted)",
        lineHeight: 1.5,
      }}
    >
      {text}
    </p>
  );
}

const inputStyle: CSSProperties = {
  background: "var(--color-bg-base)",
  border: "1px solid var(--color-border-subtle)",
  borderRadius: "var(--radius-sm)",
  padding: "var(--space-1) var(--space-2)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--color-fg-primary)",
};

const selectStyle: CSSProperties = {
  ...inputStyle,
};

const btnStyle: CSSProperties = {
  border: "none",
  borderRadius: "var(--radius-sm)",
  padding: "var(--space-1) var(--space-3)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  lineHeight: 1.6,
};
