/*
 * Agent conversation — the hero (spec 5.A.1). Renders the live engine event
 * stream from the conversation store: streaming assistant bubbles, collapsible
 * tool cards, a cost/context header, and a working prompt bar (send + stop).
 * Backed by a persistent `claude` session opened on the first turn.
 * (Markdown/syntax rendering of assistant text is a Phase 1 follow-up.)
 */

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useConversation, type ConvItem } from "@/store/conversation";

// Built-in session commands confirmed present in the CLI (2.1.190) — used as the
// slash menu's source until the live `slash_commands` list arrives with `init`.
const FALLBACK_SLASH = ["clear", "compact", "context", "config", "usage", "status"];

export function ConversationPane() {
  const items = useConversation((s) => s.items);
  const streaming = useConversation((s) => s.streaming);
  const error = useConversation((s) => s.error);
  const truncated = useConversation((s) => s.truncated);
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
  const usage = useConversation((s) => s.usage);
  const cost = useConversation((s) => s.cost);
  const model = useConversation((s) => s.model);

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
  const [open, setOpen] = useState(defaultOpen);
  const accent = item.isError ? "var(--color-status-danger)" : "var(--color-status-info)";
  return (
    <div
      style={{
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--color-border-subtle)",
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
        <span style={{ ...mono, color: "var(--color-fg-muted)", fontSize: "var(--text-xs)" }}>
          {item.status === "running" ? "running…" : "done"}
        </span>
      </button>
      {open && (
        <pre style={toolBody}>
          {`input: ${stringify(item.input)}`}
          {item.output !== undefined ? `\noutput: ${stringify(item.output)}` : ""}
        </pre>
      )}
    </div>
  );
}

function PromptBar() {
  const [value, setValue] = useState("");
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const streaming = useConversation((s) => s.streaming);
  const send = useConversation((s) => s.send);
  const cancel = useConversation((s) => s.cancel);
  const liveCommands = useConversation((s) => s.slashCommands);
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
        <li key={cmd} role="option" aria-selected={i === selected} ref={i === selected ? selRef : null}>
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

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
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
