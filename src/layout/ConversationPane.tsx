/*
 * Agent conversation — the hero (spec 5.A.1). Phase 0 renders the card language
 * (assistant text, a collapsible tool-use card, turn boundaries, a prompt bar)
 * with dummy data. The live EngineEvent stream, streaming reveal, and
 * `engine_send` wiring land in Phase 1.
 */

import { useState } from "react";
import type { CSSProperties } from "react";

export function ConversationPane() {
  return (
    <section className="flex h-full min-w-0 flex-col" style={{ background: "var(--color-bg-base)" }}>
      <PaneHeader />
      <div className="min-h-0 flex-1 overflow-y-auto" style={{ padding: "var(--space-6)" }}>
        <div className="mx-auto flex flex-col gap-[var(--space-6)]" style={{ maxWidth: "760px" }}>
          <UserTurn text="Wire the parser to the new event schema." />
          <AssistantTurn />
          <ToolUseCard />
        </div>
      </div>
      <PromptBar />
    </section>
  );
}

function PaneHeader() {
  return (
    <div
      className="flex shrink-0 items-center justify-between"
      style={{
        height: "var(--space-7)",
        padding: "0 var(--space-5)",
        borderBottom: "1px solid var(--color-border-subtle)",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color: "var(--color-fg-secondary)",
        }}
      >
        CONVERSATION
      </span>
      {/* Cost/context header indicator (P4) — dummy in Phase 0, mono voice. */}
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color: "var(--color-fg-muted)",
        }}
      >
        ctx 12.4k/200k · $0.0184
      </span>
    </div>
  );
}

function UserTurn({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-[var(--space-2)]">
      <Role label="you" color="var(--color-fg-secondary)" />
      <p style={{ color: "var(--color-fg-primary)" }}>{text}</p>
    </div>
  );
}

function AssistantTurn() {
  return (
    <div className="flex flex-col gap-[var(--space-2)]">
      <Role label="claude" color="var(--color-accent)" />
      <p style={{ color: "var(--color-fg-primary)" }}>
        I'll map each <code style={codeStyle}>stream-json</code> event to the typed{" "}
        <code style={codeStyle}>EngineEvent</code> enum by its <code style={codeStyle}>type</code>{" "}
        field, tolerating unknown variants. First, let me read the current parser.
      </p>
    </div>
  );
}

function ToolUseCard() {
  const [open, setOpen] = useState(false);
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
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-sm)",
            color: "var(--color-status-info)",
          }}
        >
          Read
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--color-fg-muted)" }}>
          src/engine/parser.rs
        </span>
      </button>
      {open && (
        <pre
          style={{
            margin: 0,
            padding: "var(--space-4)",
            borderTop: "1px solid var(--color-border-subtle)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--color-fg-secondary)",
            whiteSpace: "pre-wrap",
          }}
        >
          {`{ "file_path": "src/engine/parser.rs" }`}
        </pre>
      )}
    </div>
  );
}

function PromptBar() {
  return (
    <div
      className="shrink-0"
      style={{ padding: "var(--space-4) var(--space-5)", borderTop: "1px solid var(--color-border-subtle)" }}
    >
      <div
        className="flex items-center gap-[var(--space-3)]"
        style={{
          padding: "var(--space-3) var(--space-4)",
          borderRadius: "var(--radius-md)",
          background: "var(--color-bg-recessed)",
          border: "1px solid var(--color-border-strong)",
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)", color: "var(--color-accent)" }}>›</span>
        <input
          disabled
          placeholder="Ask Claude to…  (prompt wiring lands in Phase 1)"
          aria-label="Prompt"
          className="flex-1 bg-transparent outline-none"
          style={{
            border: "none",
            color: "var(--color-fg-primary)",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-base)",
          }}
        />
      </div>
    </div>
  );
}

function Role({ label, color }: { label: string; color: string }) {
  return (
    <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color }}>{label}</span>
  );
}

const codeStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  color: "var(--color-accent)",
  background: "var(--color-bg-recessed)",
  padding: "0 var(--space-2)",
  borderRadius: "var(--radius-sm)",
};
