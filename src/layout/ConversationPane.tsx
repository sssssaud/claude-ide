/*
 * Agent conversation — the hero (spec 5.A.1). Renders the live engine event
 * stream from the conversation store: streaming assistant bubbles, collapsible
 * tool cards, a cost/context header, and a working prompt bar (send + stop).
 * Backed by a persistent `claude` session opened on the first turn.
 * (Markdown/syntax rendering of assistant text is a Phase 1 follow-up.)
 */

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useActiveConversation, type ConvItem } from "@/store/conversation";

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
      <div className="min-h-0 flex-1 overflow-y-auto" style={{ padding: "var(--space-6)" }}>
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
      <PromptBar />
    </section>
  );
}

function PaneHeader() {
  const usage = useActiveConversation((s) => s.usage);
  const cost = useActiveConversation((s) => s.cost);
  const model = useActiveConversation((s) => s.model);

  const ctx =
    usage != null
      ? `${(usage.input_tokens + usage.output_tokens).toLocaleString()} tok`
      : model
        ? model
        : "—";
  const dollars = cost != null ? `$${cost.toFixed(4)}` : "$—";

  return (
    <div
      className="flex shrink-0 items-center justify-between"
      style={{
        height: "var(--space-7)",
        padding: "0 var(--space-5)",
        borderBottom: "1px solid var(--color-border-subtle)",
      }}
    >
      <span style={monoLabel}>CONVERSATION</span>
      <span style={{ ...monoLabel, color: "var(--color-fg-muted)" }}>
        {ctx} · {dollars}
      </span>
    </div>
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
        <div className="flex flex-col gap-[var(--space-2)]">
          <Role label="you" color="var(--color-fg-secondary)" />
          <p style={{ color: "var(--color-fg-primary)", whiteSpace: "pre-wrap" }}>{item.text}</p>
        </div>
      );
    case "assistant":
      return (
        <div className="flex flex-col gap-[var(--space-2)]">
          <Role label="claude" color="var(--color-accent)" />
          <p style={{ color: "var(--color-fg-primary)", whiteSpace: "pre-wrap" }}>
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
  const inputRef = useRef<HTMLInputElement | null>(null);

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
