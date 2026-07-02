/*
 * Agent conversation — the hero (spec 5.A.1). Renders the live engine event
 * stream from the conversation store: streaming assistant bubbles, collapsible
 * tool cards, a cost/context header, and a working prompt bar (send + stop).
 * Backed by a persistent `claude` session opened on the first turn.
 * (Markdown/syntax rendering of assistant text is a Phase 1 follow-up.)
 */

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { activeConversationStore, useActiveConversation, type ConvItem } from "@/store/conversation";
import { MODELS, useModel } from "@/store/model";
import type { Usage } from "@/ipc/types";

// Built-in session commands confirmed present in the CLI (2.1.190) — used as the
// slash menu's source until the live `slash_commands` list arrives with `init`.
const FALLBACK_SLASH = ["clear", "compact", "context", "config", "usage", "status"];

export function ConversationPane() {
  const items = useActiveConversation((s) => s.items);
  const streaming = useActiveConversation((s) => s.streaming);
  const error = useActiveConversation((s) => s.error);
  const truncated = useActiveConversation((s) => s.truncated);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [items]);

  return (
    <section className="flex h-full min-w-0 flex-col" style={{ background: "var(--color-bg-base)" }}>
      <PaneHeader />
      <div className="min-h-0 flex-1 overflow-y-auto" style={{ padding: "var(--space-6)", overflowX: "hidden" }}>
        {items.length === 0 ? (
          <EmptyInvite />
        ) : (
          <div className="mx-auto flex flex-col gap-[var(--space-6)]" style={{ maxWidth: "760px" }}>
            {truncated && (
              <p
                role="note"
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-xs)",
                  color: "var(--color-fg-muted)",
                  textAlign: "center",
                }}
              >
                — earlier history trimmed; showing the most recent messages —
              </p>
            )}
            {items.map((item) => (
              <ConversationItem key={item.id} item={item} streaming={streaming} />
            ))}
            {streaming && <StreamingDot />}
            {error && <ErrorLine message={error} />}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
      <ContextWarningBanner />
      <PromptBar />
    </section>
  );
}

/** Estimated total context tokens for a turn's usage — `input_tokens` alone
 *  badly undercounts it; the cache fields dominate on a long session
 *  (Addendum III §S9). An estimate, not a fact the CLI reports directly. */
function contextTokens(usage: Usage): number {
  return (
    usage.input_tokens +
    usage.output_tokens +
    usage.cache_read_input_tokens +
    usage.cache_creation_input_tokens
  );
}

const CONTEXT_WINDOW_KEY = "ide:context-window-tokens";
const DEFAULT_CONTEXT_WINDOW = 200_000;
/** Show once estimated usage crosses this fraction of the configured window —
 *  matches the point the CLI itself starts nagging about `/compact`. */
const WARN_RATIO = 0.8;
/** After a dismiss, require this much further growth (as a fraction of the
 *  window) before re-arming — so the banner doesn't reappear on every token. */
const RE_ARM_RATIO = 0.05;

function loadContextWindow(): number {
  try {
    const raw = localStorage.getItem(CONTEXT_WINDOW_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_CONTEXT_WINDOW;
  } catch {
    return DEFAULT_CONTEXT_WINDOW;
  }
}

/** A dismissible heads-up when the estimated context is getting full, with a
 *  one-click "Compact now" — `/compact` sent as an ordinary turn (spec 2.3's
 *  existing `send()` path; zero new backend plumbing). Addendum III §S9: the
 *  user asked for a notification instead of having to notice the CLI's own
 *  `/compact` nag themselves. The window size is a user-editable ESTIMATE
 *  (localStorage, mirroring the Usage panel's editable $/Mtok rates) — the
 *  CLI reports no per-model context-window-size fact today. */
function ContextWarningBanner() {
  const usage = useActiveConversation((s) => s.usage);
  const dismissedAt = useActiveConversation((s) => s.contextWarningDismissedAt);
  const dismiss = useActiveConversation((s) => s.dismissContextWarning);
  const streaming = useActiveConversation((s) => s.streaming);
  const [windowSize, setWindowSize] = useState(loadContextWindow);
  const [editing, setEditing] = useState(false);

  const used = usage ? contextTokens(usage) : 0;
  const ratio = windowSize > 0 ? used / windowSize : 0;
  const reArmed = dismissedAt == null || used > dismissedAt + windowSize * RE_ARM_RATIO;
  const show = usage != null && ratio >= WARN_RATIO && reArmed;

  const saveWindow = (v: number) => {
    const next = Number.isFinite(v) && v > 0 ? Math.round(v) : DEFAULT_CONTEXT_WINDOW;
    setWindowSize(next);
    try {
      localStorage.setItem(CONTEXT_WINDOW_KEY, String(next));
    } catch {
      /* storage unavailable — the estimate just won't persist */
    }
  };

  if (!show) return null;

  const pct = Math.min(999, Math.round(ratio * 100));

  return (
    <div role="status" style={bannerStyle}>
      <span style={{ fontSize: "var(--text-sm)", color: "var(--color-fg-primary)" }}>
        Context ~{pct}% full (estimate) — the CLI will start trimming early history soon.
      </span>
      <div className="flex items-center gap-[var(--space-2)]" style={{ marginLeft: "auto" }}>
        {editing ? (
          <input
            autoFocus
            type="number"
            min={1000}
            defaultValue={windowSize}
            onBlur={(e) => {
              saveWindow(e.target.valueAsNumber);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setEditing(false);
            }}
            style={{
              width: "84px",
              background: "var(--color-bg-base)",
              border: "1px solid var(--color-border-subtle)",
              borderRadius: "var(--radius-sm)",
              padding: "1px var(--space-1)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--color-fg-primary)",
            }}
          />
        ) : (
          <button type="button" onClick={() => setEditing(true)} className="cursor-pointer" style={bannerGhostBtnStyle}>
            window: {windowSize.toLocaleString()}
          </button>
        )}
        <button
          type="button"
          onClick={() => void activeConversationStore().getState().send("/compact")}
          disabled={streaming}
          className={streaming ? "" : "cursor-pointer"}
          style={bannerBtnStyle}
        >
          Compact now
        </button>
        <button type="button" onClick={() => dismiss(used)} className="cursor-pointer" style={bannerGhostBtnStyle}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

const bannerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  flexWrap: "wrap",
  padding: "var(--space-2) var(--space-5)",
  borderTop: "1px solid var(--color-status-awaiting)",
  background: "var(--color-bg-raised)",
};

const bannerBtnStyle: CSSProperties = {
  border: "1px solid var(--color-status-awaiting)",
  borderRadius: "var(--radius-sm)",
  padding: "2px var(--space-3)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  background: "var(--color-status-awaiting)",
  color: "var(--color-bg-base)",
};

const bannerGhostBtnStyle: CSSProperties = {
  border: "1px solid var(--color-border-subtle)",
  borderRadius: "var(--radius-sm)",
  padding: "2px var(--space-3)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  background: "transparent",
  color: "var(--color-fg-secondary)",
};

function PaneHeader() {
  const usage = useActiveConversation((s) => s.usage);
  const cost = useActiveConversation((s) => s.cost);
  const sessionLive = useActiveConversation((s) => s.workspaceId != null);

  const ctx = usage != null ? `${contextTokens(usage).toLocaleString()} tok` : "—";
  const dollars = cost != null ? `$${cost.toFixed(4)}` : "$—";

  return (
    <div
      className="flex shrink-0 items-center justify-between gap-[var(--space-3)]"
      style={{
        height: "var(--space-7)",
        padding: "0 var(--space-5)",
        borderBottom: "1px solid var(--color-border-subtle)",
      }}
    >
      <span style={monoLabel}>CONVERSATION</span>
      <div className="flex min-w-0 items-center gap-[var(--space-3)]">
        <ModelPicker sessionLive={sessionLive} />
        <span style={{ ...monoLabel, color: "var(--color-fg-muted)" }}>
          {ctx} · {dollars}
        </span>
      </div>
    </div>
  );
}

/** Picks the model the NEXT session spawns with (`--model`). While a session is
 *  live the choice can't change that running session (the CLI sets the model at
 *  spawn) — the tooltip and an "(next)" suffix say so. */
function ModelPicker({ sessionLive }: { sessionLive: boolean }) {
  const model = useModel((s) => s.model);
  const setModel = useModel((s) => s.setModel);
  const appliesNext = sessionLive;

  return (
    <label className="flex items-center gap-[var(--space-1)]" title={appliesNext ? "Model for the next session (the running one keeps its model)" : "Model for this session"}>
      <span aria-hidden="true" style={{ ...monoLabel, color: "var(--color-fg-muted)" }}>
        model
      </span>
      <select
        value={model}
        onChange={(e) => setModel(e.target.value)}
        aria-label="Session model"
        className="cursor-pointer"
        style={{
          background: "transparent",
          border: "1px solid var(--color-border-subtle)",
          borderRadius: "var(--radius-sm)",
          padding: "0 var(--space-1)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color: "var(--color-fg-secondary)",
        }}
      >
        {MODELS.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
            {appliesNext ? " (next)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

function EmptyInvite() {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-[var(--space-3)] text-center"
      role="status"
    >
      <p style={{ color: "var(--color-fg-primary)", fontSize: "var(--text-md)" }}>
        Ask Claude to…
      </p>
      <p style={{ color: "var(--color-fg-secondary)", maxWidth: "44ch" }}>
        Type a prompt below to start a turn. The first message opens a live
        Claude session; responses stream in as cards.
      </p>
    </div>
  );
}

function ConversationItem({ item, streaming }: { item: ConvItem; streaming: boolean }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="group/turn flex flex-col gap-[var(--space-2)]">
          <div className="flex items-center justify-between">
            <Role label="you" color="var(--color-fg-secondary)" />
            <CopyMarkdownButton text={`**You:**\n\n${item.text}`} />
          </div>
          <p style={{ color: "var(--color-fg-primary)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.text}</p>
        </div>
      );
    case "assistant":
      return (
        <div className="group/turn flex flex-col gap-[var(--space-2)]">
          <div className="flex items-center justify-between">
            <Role label="claude" color="var(--color-accent)" />
            <CopyMarkdownButton text={`**Claude:**\n\n${item.text}`} />
          </div>
          <p style={{ color: "var(--color-fg-primary)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {item.text}
            {item.stopped && (
              <span style={{ color: "var(--color-fg-muted)", fontStyle: "italic" }}> (stopped)</span>
            )}
          </p>
        </div>
      );
    case "notice":
      return (
        <p
          role="status"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--color-fg-muted)",
            textAlign: "center",
          }}
        >
          ✓ {item.text}
        </p>
      );
    case "tool":
      return <ToolCard item={item} defaultOpen={streaming} />;
  }
}

function ToolCard({
  item,
  defaultOpen,
}: {
  item: Extract<ConvItem, { kind: "tool" }>;
  defaultOpen: boolean;
}) {
  const awaiting = item.status === "awaiting";
  // A pending approval is always expanded — the user must see the action to
  // decide on it (spec 3.6 / 5.A.1).
  const [open, setOpen] = useState(defaultOpen || awaiting);
  useEffect(() => {
    if (awaiting) setOpen(true);
  }, [awaiting]);

  const accent = awaiting
    ? "var(--color-accent)"
    : item.isError
      ? "var(--color-status-danger)"
      : "var(--color-status-info)";
  const statusText =
    item.status === "awaiting" ? "needs approval" : item.status === "running" ? "running…" : "done";

  return (
    <div
      style={{
        borderRadius: "var(--radius-md)",
        border: awaiting
          ? "1px solid var(--color-accent)"
          : "1px solid var(--color-border-subtle)",
        background: "var(--color-bg-raised)",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-[var(--space-3)]"
        style={{ padding: "var(--space-3) var(--space-4)", background: "transparent", border: "none" }}
      >
        <span aria-hidden="true" style={{ color: "var(--color-fg-muted)" }}>
          {open ? "▾" : "▸"}
        </span>
        <span style={{ ...mono, color: accent }}>{item.name}</span>
        <span style={{ ...mono, color: awaiting ? "var(--color-accent)" : "var(--color-fg-muted)", fontSize: "var(--text-xs)" }}>
          {statusText}
        </span>
      </button>
      {open && (
        <pre style={toolBody}>
          {`input: ${stringify(item.input)}`}
          {item.output !== undefined ? `\noutput: ${stringify(item.output)}` : ""}
        </pre>
      )}
      {awaiting && <PermissionReview item={item} />}
    </div>
  );
}

/**
 * Inline approval card for a tool the agent wants to run (P1, spec 3.6). Shows a
 * faithful preview of the proposed action — a write's contents, an edit's
 * before/after, a shell command — then Approve / Reject. The CLI is blocked
 * until one is chosen; the answer resumes the turn (editing the proposed input
 * before approving lands in a later slice).
 */
function PermissionReview({ item }: { item: Extract<ConvItem, { kind: "tool" }> }) {
  const resolve = useActiveConversation((s) => s.resolvePermission);
  const preview = permissionPreview(item.name, item.input);
  // Edit mode: the proposed input as editable JSON. Approve then runs the
  // user's edited version (`updatedInput`), not the original (spec 3.6).
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [parseErr, setParseErr] = useState<string | null>(null);

  const startEditing = () => {
    setDraft(stringify(item.input, 2));
    setParseErr(null);
    setEditing(true);
  };

  const approve = () => {
    if (!editing) {
      void resolve(item.id, "allow");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch {
      setParseErr("Edited input is not valid JSON");
      return;
    }
    void resolve(item.id, "allow", parsed);
  };

  return (
    <div
      role="group"
      aria-label={`Approve ${item.name}`}
      style={{ borderTop: "1px solid var(--color-accent)", padding: "var(--space-4)" }}
    >
      <p style={{ ...mono, fontSize: "var(--text-xs)", color: "var(--color-fg-muted)", marginBottom: "var(--space-2)" }}>
        {editing ? `Edit input — ${item.name}` : preview.label}
      </p>
      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => {
            setDraft(e.currentTarget.value);
            setParseErr(null);
          }}
          aria-label="Edit tool input (JSON)"
          spellCheck={false}
          style={{
            width: "100%",
            minHeight: "160px",
            marginBottom: parseErr ? "var(--space-1)" : "var(--space-3)",
            padding: "var(--space-3)",
            borderRadius: "var(--radius-sm)",
            background: "var(--color-bg-recessed)",
            border: "1px solid var(--color-border-strong)",
            color: "var(--color-fg-primary)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            resize: "vertical",
          }}
        />
      ) : (
        <pre
          style={{
            margin: 0,
            marginBottom: "var(--space-3)",
            maxHeight: "240px",
            overflow: "auto",
            padding: "var(--space-3)",
            borderRadius: "var(--radius-sm)",
            background: "var(--color-bg-recessed)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--color-fg-secondary)",
            whiteSpace: "pre-wrap",
          }}
        >
          {preview.body}
        </pre>
      )}
      {parseErr && (
        <p role="alert" style={{ marginBottom: "var(--space-2)", fontSize: "var(--text-xs)", color: "var(--color-status-danger)" }}>
          {parseErr}
        </p>
      )}
      <div className="flex items-center justify-end gap-[var(--space-3)]">
        {!editing && (
          <button
            type="button"
            onClick={startEditing}
            className="mr-auto cursor-pointer"
            style={{ ...stopBtn, borderColor: "var(--color-border-subtle)" }}
          >
            Edit
          </button>
        )}
        <button
          type="button"
          onClick={() => void resolve(item.id, "deny")}
          className="cursor-pointer"
          style={stopBtn}
        >
          Reject
        </button>
        <button type="button" onClick={approve} className="cursor-pointer" style={sendBtn}>
          {editing ? "Approve edited" : "Approve"}
        </button>
      </div>
    </div>
  );
}

/** A human-readable preview of a proposed tool action for the approval card. */
function permissionPreview(name: string, input: unknown): { label: string; body: string } {
  const obj = (input ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof obj[k] === "string" ? (obj[k] as string) : undefined);
  switch (name) {
    case "Bash":
      return {
        label: str("description") ? `Run command — ${str("description")}` : "Run a shell command",
        body: str("command") ?? stringify(input),
      };
    case "Write":
      return {
        label: `Write ${str("file_path") ?? "a file"}`,
        body: str("content") ?? stringify(input),
      };
    case "Edit":
      return {
        label: `Edit ${str("file_path") ?? "a file"}`,
        body:
          str("old_string") !== undefined
            ? `- ${str("old_string")}\n+ ${str("new_string") ?? ""}`
            : stringify(input),
      };
    default:
      return { label: `Run ${name}`, body: stringify(input, 2) };
  }
}

function PromptBar() {
  const [value, setValue] = useState("");
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const streaming = useActiveConversation((s) => s.streaming);
  const send = useActiveConversation((s) => s.send);
  const cancel = useActiveConversation((s) => s.cancel);
  const liveCommands = useActiveConversation((s) => s.slashCommands);
  const draftInsert = useActiveConversation((s) => s.draftInsert);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // "Re-run" a past prompt found via cross-session search (§S7) — populates
  // the composer for review, never auto-sends. Consumed once, like the
  // editor's own `reveal`/`clearReveal` pending-request pattern.
  useEffect(() => {
    if (draftInsert === null) return;
    setValue(draftInsert);
    setDismissed(false);
    setSel(0);
    inputRef.current?.focus();
    activeConversationStore().getState().clearDraftInsert();
  }, [draftInsert]);

  const commands = liveCommands.length ? liveCommands : FALLBACK_SLASH;
  // The slash menu is active while typing a command name: a leading "/" with no
  // space yet (once a space is typed the rest is treated as the command's args).
  const slashQuery =
    value.startsWith("/") && !value.includes(" ") ? value.slice(1).toLowerCase() : null;
  const matches =
    slashQuery !== null
      ? commands.filter((c) => c.toLowerCase().includes(slashQuery)).slice(0, 50)
      : [];
  const menuOpen = !dismissed && matches.length > 0;
  const selected = Math.min(sel, matches.length - 1);

  const change = (next: string) => {
    setValue(next);
    setDismissed(false);
    setSel(0);
  };

  const accept = (cmd: string) => {
    change(`/${cmd} `); // trailing space leaves room for args + closes the menu
    inputRef.current?.focus();
  };

  const submit = () => {
    const text = value.trim();
    if (!text || streaming) return;
    void send(text);
    setValue("");
    setDismissed(false);
    setSel(0);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (menuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => (Math.min(s, matches.length - 1) + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => (Math.min(s, matches.length - 1) - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        accept(matches[selected]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      className="shrink-0"
      style={{ padding: "var(--space-4) var(--space-5)", borderTop: "1px solid var(--color-border-subtle)" }}
    >
      <div className="relative">
        {menuOpen && <SlashMenu matches={matches} selected={selected} onPick={accept} />}
        <div
          className="flex items-center gap-[var(--space-3)]"
          style={{
            padding: "var(--space-3) var(--space-4)",
            borderRadius: "var(--radius-md)",
            background: "var(--color-bg-recessed)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          <span style={{ ...mono, color: "var(--color-accent)" }}>›</span>
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => change(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask Claude to…   ( / for commands )"
            aria-label="Prompt"
            role="combobox"
            aria-expanded={menuOpen}
            aria-controls="slash-menu"
            aria-activedescendant={menuOpen ? `slash-opt-${selected}` : undefined}
            className="flex-1 bg-transparent outline-none"
            style={{
              border: "none",
              color: "var(--color-fg-primary)",
              fontFamily: "var(--font-sans)",
              fontSize: "var(--text-base)",
            }}
          />
          {streaming ? (
            <button type="button" onClick={() => void cancel()} className="cursor-pointer" style={stopBtn}>
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!value.trim()}
              className="cursor-pointer"
              style={{ ...sendBtn, opacity: value.trim() ? 1 : 0.4 }}
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Slash-command autocomplete, anchored above the prompt bar. Driven by the
 * session's real `slash_commands` (filtered by the typed query). */
function SlashMenu({
  matches,
  selected,
  onPick,
}: {
  matches: string[];
  selected: number;
  onPick: (cmd: string) => void;
}) {
  const selRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    selRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <ul
      id="slash-menu"
      role="listbox"
      className="absolute left-0 right-0 overflow-y-auto"
      style={{
        bottom: "calc(100% + var(--space-2))",
        maxHeight: "240px",
        background: "var(--color-bg-raised)",
        border: "1px solid var(--color-border-strong)",
        borderRadius: "var(--radius-md)",
        padding: "var(--space-2)",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.4)",
        zIndex: 20,
      }}
    >
      {matches.map((cmd, i) => (
        <li
          key={cmd}
          id={`slash-opt-${i}`}
          role="option"
          aria-selected={i === selected}
          ref={i === selected ? selRef : null}
        >
          <button
            type="button"
            // mousedown (not click) so the pick fires before the input blurs
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(cmd);
            }}
            className="flex w-full cursor-pointer items-center text-left"
            style={{
              padding: "var(--space-2) var(--space-3)",
              borderRadius: "var(--radius-sm)",
              border: "none",
              background: i === selected ? "var(--color-bg-recessed)" : "transparent",
              color: "var(--color-fg-primary)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-sm)",
            }}
          >
            <span style={{ color: "var(--color-accent)" }}>/</span>
            {cmd}
          </button>
        </li>
      ))}
    </ul>
  );
}

function StreamingDot() {
  return (
    <span
      className="status-lamp-pulse"
      aria-label="Claude is responding"
      style={{
        width: "8px",
        height: "8px",
        borderRadius: "50%",
        background: "var(--color-status-running)",
      }}
    />
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <p role="alert" style={{ color: "var(--color-status-danger)", fontSize: "var(--text-sm)" }}>
      {message}
    </p>
  );
}

function Role({ label, color }: { label: string; color: string }) {
  return <span style={{ ...mono, color }}>{label}</span>;
}

/** Copies one turn as Markdown (Addendum II §S7) — revealed on hover/focus,
 *  like the tab strip's close button; briefly confirms so a silent clipboard
 *  write doesn't look like nothing happened. */
function CopyMarkdownButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      title="Copy as Markdown"
      aria-label="Copy as Markdown"
      className="cursor-pointer opacity-0 transition-opacity focus:opacity-100 group-hover/turn:opacity-100"
      style={{ border: "none", background: "transparent", padding: 0, color: "var(--color-fg-muted)", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", transitionDuration: "var(--motion-fast)" }}
    >
      {copied ? "✓ copied" : "copy ⧉"}
    </button>
  );
}

function stringify(value: unknown, indent?: number): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, indent);
  } catch {
    return String(value);
  }
}

const mono: CSSProperties = { fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" };
const monoLabel: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--color-fg-secondary)",
};
const toolBody: CSSProperties = {
  margin: 0,
  padding: "var(--space-4)",
  borderTop: "1px solid var(--color-border-subtle)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--color-fg-secondary)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};
const sendBtn: CSSProperties = {
  border: "1px solid var(--color-accent)",
  background: "var(--color-accent)",
  color: "var(--color-bg-base)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: 500,
  padding: "var(--space-2) var(--space-4)",
  borderRadius: "var(--radius-sm)",
};
const stopBtn: CSSProperties = {
  border: "1px solid var(--color-border-strong)",
  background: "transparent",
  color: "var(--color-fg-primary)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: 500,
  padding: "var(--space-2) var(--space-4)",
  borderRadius: "var(--radius-sm)",
};
