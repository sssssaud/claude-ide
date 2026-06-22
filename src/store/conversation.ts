/*
 * Conversation store (spec 2.5, 5.A.1). Derived, read-only mirror of the engine
 * event stream: it consumes `EngineEvent`s and builds an id-keyed list of
 * conversation items. Rendering keys off these ids; unknown event types are
 * ignored (newer-CLI tolerance, spec 2.3).
 */

import { create } from "zustand";
import { engineCancel, engineSend } from "@/ipc/commands";
import type { EngineEvent, Usage } from "@/ipc/types";
import { isIpcError } from "@/ipc/types";

export type ConvItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; stopped?: boolean }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: unknown;
      output?: unknown;
      isError?: boolean;
      status: "running" | "done";
    };

interface ConversationState {
  items: ConvItem[];
  streaming: boolean;
  activeTurnId: string | null;
  sessionId: string | null;
  model: string | null;
  slashCommands: string[];
  cost: number | null;
  usage: Usage | null;
  error: string | null;
  send: (prompt: string) => Promise<void>;
  cancel: () => Promise<void>;
}

export const useConversation = create<ConversationState>((set, get) => {
  // Module-local cursors (not reactive state): which assistant bubble is
  // currently accumulating deltas. Reset on tool calls and turn boundaries so a
  // post-tool reply renders as a new bubble.
  let assistantSeq = 0;
  let currentAssistantId: string | null = null;

  const dispatch = (ev: EngineEvent) => {
    set((s) => {
      switch (ev.type) {
        case "init":
          return {
            sessionId: ev.session_id,
            model: ev.model,
            slashCommands: ev.slash_commands,
          };

        case "assistant_delta": {
          let items = s.items;
          if (!currentAssistantId) {
            currentAssistantId = `a-${assistantSeq++}`;
            items = [...items, { kind: "assistant", id: currentAssistantId, text: "" }];
          }
          const aid = currentAssistantId;
          return {
            items: items.map((it) =>
              it.id === aid && it.kind === "assistant"
                ? { ...it, text: it.text + ev.text }
                : it,
            ),
          };
        }

        case "tool_use":
          currentAssistantId = null; // next deltas start a fresh bubble
          return {
            items: [
              ...s.items,
              { kind: "tool", id: ev.id, name: ev.name, input: ev.input, status: "running" },
            ],
          };

        case "tool_result":
          return {
            items: s.items.map((it) =>
              it.kind === "tool" && it.id === ev.id
                ? { ...it, output: ev.output, isError: ev.is_error, status: "done" }
                : it,
            ),
          };

        case "result":
          currentAssistantId = null;
          return {
            streaming: false,
            activeTurnId: null,
            cost: ev.total_cost_usd,
            usage: ev.usage,
            sessionId: ev.session_id,
          };

        case "stopped": {
          const aid = currentAssistantId;
          currentAssistantId = null;
          return {
            streaming: false,
            activeTurnId: null,
            items: s.items.map((it) =>
              it.id === aid && it.kind === "assistant" ? { ...it, stopped: true } : it,
            ),
          };
        }

        default:
          return {}; // unknown event type from a newer CLI: ignore, never crash
      }
    });
  };

  return {
    items: [],
    streaming: false,
    activeTurnId: null,
    sessionId: null,
    model: null,
    slashCommands: [],
    cost: null,
    usage: null,
    error: null,

    send: async (prompt: string) => {
      const text = prompt.trim();
      if (!text || get().streaming) return;
      currentAssistantId = null;
      set((s) => ({
        items: [...s.items, { kind: "user", id: `u-${Date.now()}`, text }],
        streaming: true,
        error: null,
      }));
      try {
        // Events may arrive before this resolves; dispatch is turn-id-agnostic,
        // so that is fine. The id is only needed for cancel.
        const turnId = await engineSend(text, dispatch);
        set({ activeTurnId: turnId });
      } catch (e) {
        set({
          streaming: false,
          error: isIpcError(e) ? e.message : "Failed to send the turn",
        });
      }
    },

    cancel: async () => {
      const id = get().activeTurnId;
      if (!id) return;
      try {
        await engineCancel(id);
      } catch {
        /* best-effort; the turn will also end on its own */
      }
    },
  };
});
