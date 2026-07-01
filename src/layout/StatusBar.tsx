/*
 * Status bar (Addendum II §S5, §4). A bottom strip, always present (hidden
 * only in zen mode, same as the activity bar): branch/ahead-behind + agent
 * status on the left; Ln:Col, selection, indent, EOL, language, cost/tokens,
 * and theme on the right — every segment clickable, mono numerals.
 *
 * Two segments the addendum lists — a Problems count and a notification bell —
 * are deliberately NOT here: there's no diagnostics/problems provider in the
 * app yet (Problems is its own placeholder in the later bottom-panel work) and
 * no notification system to back a bell. Faking either with placeholder data
 * would be worse than not having them; they're real additions once their
 * backing systems exist, not this slice.
 */

import { useState } from "react";
import { openSettings } from "@/commands/registry";
import { getActiveEditorHandle } from "@/store/activeEditorHandle";
import { useActiveConversation } from "@/store/conversation";
import { useEditorStatus } from "@/store/editorStatus";
import { useGit } from "@/store/git";
import { useLayout } from "@/store/layout";
import { THEME_OPTIONS, useTheme } from "@/store/theme";
import { LANGUAGE_OPTIONS, languageLabel } from "@/editor/language";
import { FuzzyOverlay } from "@/layout/FuzzyOverlay";

export function StatusBar() {
  return (
    <div
      className="flex shrink-0 items-center justify-between"
      style={{
        height: "var(--space-6)",
        padding: "0 var(--space-3)",
        background: "var(--color-bg-recessed)",
        borderTop: "1px solid var(--color-border-subtle)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
      }}
    >
      <div className="flex min-w-0 items-center">
        <BranchSegment />
        <AgentStatusSegment />
      </div>
      <div className="flex min-w-0 items-center">
        <LineColSegment />
        <SelectionSegment />
        <IndentSegment />
        <EolSegment />
        <LanguageSegment />
        <CostSegment />
        <ThemeSegment />
      </div>
    </div>
  );
}

function Segment({
  onClick,
  disabled,
  title,
  children,
}: {
  onClick?: () => void;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || !onClick}
      title={title}
      aria-label={title}
      className={onClick && !disabled ? "cursor-pointer" : undefined}
      style={{
        height: "100%",
        padding: "0 var(--space-3)",
        border: "none",
        background: "transparent",
        color: disabled ? "var(--color-fg-muted)" : "var(--color-fg-secondary)",
        fontFamily: "inherit",
        fontSize: "inherit",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

// ---- Left: source control + agent status ------------------------------------

function BranchSegment() {
  const status = useGit((s) => s.status);
  if (!status?.isRepo) return null;
  const dirty = status.ahead > 0 || status.behind > 0;
  return (
    <Segment onClick={() => useLayout.getState().selectView("git")} title="Open Source Control">
      <span aria-hidden="true">⎇</span> {status.branch ?? "detached"}
      {dirty && (
        <span style={{ marginLeft: "var(--space-2)" }}>
          {status.ahead > 0 && `↑${status.ahead}`}
          {status.behind > 0 && ` ↓${status.behind}`}
        </span>
      )}
    </Segment>
  );
}

function AgentStatusSegment() {
  const streaming = useActiveConversation((s) => s.streaming);
  const cancel = useActiveConversation((s) => s.cancel);
  return (
    <Segment
      onClick={streaming ? () => void cancel() : undefined}
      title={streaming ? "Agent running — click to stop" : "Agent idle"}
    >
      <span
        aria-hidden="true"
        className={streaming ? "status-lamp-pulse" : undefined}
        style={{
          display: "inline-block",
          width: "7px",
          height: "7px",
          marginRight: "var(--space-2)",
          borderRadius: "50%",
          background: streaming ? "var(--color-status-running)" : "var(--color-status-idle)",
        }}
      />
      {streaming ? "Running" : "Idle"}
    </Segment>
  );
}

// ---- Right: file status -------------------------------------------------

function LineColSegment() {
  const path = useEditorStatus((s) => s.path);
  const line = useEditorStatus((s) => s.line);
  const column = useEditorStatus((s) => s.column);
  if (!path) return null;
  return (
    <Segment
      onClick={() => getActiveEditorHandle()?.editor.getAction("editor.action.gotoLine")?.run()}
      title="Go to Line/Column…"
    >
      Ln {line}, Col {column}
    </Segment>
  );
}

function SelectionSegment() {
  const path = useEditorStatus((s) => s.path);
  const selectionLength = useEditorStatus((s) => s.selectionLength);
  if (!path || selectionLength <= 0) return null;
  return (
    <Segment
      onClick={() => {
        const handle = getActiveEditorHandle();
        const sel = handle?.editor.getSelection();
        const model = handle?.editor.getModel();
        if (!sel || !model) return;
        void navigator.clipboard.writeText(model.getValueInRange(sel));
      }}
      title="Copy selection to clipboard"
    >
      {selectionLength} selected
    </Segment>
  );
}

function IndentSegment() {
  const path = useEditorStatus((s) => s.path);
  const tabSize = useEditorStatus((s) => s.tabSize);
  const insertSpaces = useEditorStatus((s) => s.insertSpaces);
  if (!path) return null;
  return (
    <Segment onClick={openSettings} title="Open indentation settings">
      {insertSpaces ? "Spaces" : "Tabs"}: {tabSize}
    </Segment>
  );
}

function EolSegment() {
  const path = useEditorStatus((s) => s.path);
  const eol = useEditorStatus((s) => s.eol);
  if (!path) return null;
  return (
    <Segment
      onClick={() => getActiveEditorHandle()?.setEol(eol === "LF" ? "CRLF" : "LF")}
      title={`Line ending: ${eol} — click to switch to ${eol === "LF" ? "CRLF" : "LF"}`}
    >
      {eol}
    </Segment>
  );
}

function LanguageSegment() {
  const path = useEditorStatus((s) => s.path);
  const language = useEditorStatus((s) => s.language);
  const [open, setOpen] = useState(false);
  if (!path) return null;
  return (
    <>
      <Segment onClick={() => setOpen(true)} title="Select Language Mode…">
        {language ? languageLabel(language) : "Plain Text"}
      </Segment>
      <FuzzyOverlay
        open={open}
        onClose={() => setOpen(false)}
        placeholder="Select language mode…"
        ariaLabel="Select Language Mode"
        emptyLabel="No matching languages."
        items={LANGUAGE_OPTIONS}
        itemKey={(l) => l.id}
        itemText={(l) => l.label}
        onSelect={(l) => getActiveEditorHandle()?.setLanguage(l.id)}
        renderItem={(l) => <div style={{ padding: "var(--space-3)" }}>{l.label}</div>}
      />
    </>
  );
}

function CostSegment() {
  const cost = useActiveConversation((s) => s.cost);
  const usage = useActiveConversation((s) => s.usage);
  if (cost == null && usage == null) return null;
  const tokens = usage ? (usage.input_tokens + usage.output_tokens).toLocaleString() : null;
  const dollars = cost != null ? `$${cost.toFixed(4)}` : null;
  return (
    <Segment onClick={() => useLayout.getState().selectView("usage")} title="Open Usage">
      {[dollars, tokens && `${tokens} tok`].filter(Boolean).join(" · ")}
    </Segment>
  );
}

function ThemeSegment() {
  const choice = useTheme((s) => s.choice);
  const label = THEME_OPTIONS.find((o) => o.value === choice)?.label ?? choice;
  return (
    <Segment onClick={openSettings} title="Open Appearance settings">
      {label}
    </Segment>
  );
}
