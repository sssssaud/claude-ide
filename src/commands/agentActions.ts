/*
 * The agent-bridge (Addendum II §S4, §3.1) — the actions that make this a
 * *Claude* IDE: select code, ask Claude to explain/refactor/fix/test/document
 * it. Each builds a structured prompt (task + file path + line range + a
 * fenced code block of the selection) and sends it through the SAME turn path
 * the prompt bar itself uses (`useActiveConversation().send`, which already
 * goes through `engine_send`) — no new exec path, no new IPC surface.
 *
 * Shared by both the Monaco right-click/command menu (`editor.addAction` in
 * EditorPane) and the Command Palette (`commands/registry.ts`), so there's one
 * implementation instead of two copies of the same prompt-building logic.
 */

import { getActiveEditorHandle } from "@/store/activeEditorHandle";
import { activeConversationStore } from "@/store/conversation";

export type AgentActionKind = "explain" | "refactor" | "fix" | "tests" | "docstring";

export const AGENT_ACTION_LABELS: Record<AgentActionKind, string> = {
  explain: "Explain Selection",
  refactor: "Refactor Selection",
  fix: "Fix This",
  tests: "Add Tests for Selection",
  docstring: "Add Docstring",
};

const TASK_INSTRUCTION: Record<AgentActionKind, string> = {
  explain: "Explain what this code does.",
  refactor: "Refactor this code for clarity and simplicity, keeping its behavior identical.",
  fix: "There's a bug in this code. Find it and fix it.",
  tests: "Write tests for this code.",
  docstring: "Add a concise docstring/comment for this code.",
};

/** Whether there's an active editor with a non-empty selection right now —
 *  the palette uses this to grey the action out instead of showing a dead row. */
export function hasAgentActionTarget(): boolean {
  const sel = getActiveEditorHandle()?.editor.getSelection();
  return !!sel && !sel.isEmpty() && !activeConversationStore().getState().streaming;
}

/** Whether there's an active editor at all right now — no selection required,
 *  unlike `hasAgentActionTarget` (Addendum II §S7's "Ask About This Line" acts
 *  on the cursor's line, not a selection). */
export function hasLineActionTarget(): boolean {
  return !!getActiveEditorHandle() && !activeConversationStore().getState().streaming;
}

/** The line the cursor is currently on, for the "Ask About This Line" modal to
 *  show what it's about to ask against. `null` if there's no active editor. */
export function currentLineContext(): { path: string; line: number } | null {
  const handle = getActiveEditorHandle();
  const position = handle?.editor.getPosition();
  if (!handle || !position) return null;
  return { path: handle.getActivePath() ?? "(unknown file)", line: position.lineNumber };
}

/** Send a free-form question about the line the cursor is on right now
 *  (Addendum II §S7) — the one agent-bridge action that doesn't need a
 *  selection. Reads the cursor fresh at send time (not whenever the "Ask"
 *  modal was opened), same no-op guards as `sendAgentAction`. */
export function sendLineQuestion(question: string): void {
  const q = question.trim();
  if (!q) return;
  const handle = getActiveEditorHandle();
  if (!handle) return;
  const editor = handle.editor;
  const model = editor.getModel();
  const position = editor.getPosition();
  if (!model || !position) return;

  const convo = activeConversationStore();
  if (convo.getState().streaming) return;

  const line = model.getLineContent(position.lineNumber);
  const path = handle.getActivePath() ?? "(unknown file)";
  const language = model.getLanguageId();
  const prompt = `${q}\n\n${path} (line ${position.lineNumber}):\n\`\`\`${language}\n${line}\n\`\`\``;
  void convo.getState().send(prompt);
}

/** Build the prompt for the current selection and send it as a real turn.
 *  A no-op if there's no active editor/selection, or a turn is already
 *  in flight (mirrors the prompt bar's own guard). */
export function sendAgentAction(kind: AgentActionKind): void {
  const handle = getActiveEditorHandle();
  if (!handle) return;
  const editor = handle.editor;
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection || selection.isEmpty()) return;

  const convo = activeConversationStore();
  if (convo.getState().streaming) return;

  const code = model.getValueInRange(selection);
  const path = handle.getActivePath() ?? "(unknown file)";
  const language = model.getLanguageId();
  const lineRange =
    selection.startLineNumber === selection.endLineNumber
      ? `line ${selection.startLineNumber}`
      : `lines ${selection.startLineNumber}-${selection.endLineNumber}`;

  const prompt = `${TASK_INSTRUCTION[kind]}\n\n${path} (${lineRange}):\n\`\`\`${language}\n${code}\n\`\`\``;
  void convo.getState().send(prompt);
}
