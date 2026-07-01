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
