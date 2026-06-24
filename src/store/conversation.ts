/*
 * Conversation store (spec 2.5, 5.A.1). Derived, read-only mirror of the engine
 * event stream: it consumes `EngineEvent`s and builds an id-keyed list of
 * conversation items. Rendering keys off these ids; unknown event types are
 * ignored (newer-CLI tolerance, spec 2.3).
 */

import { create } from "zustand";
import {
  closeWorkspace,
  engineCancel,
  engineSend,
  openWorkspace,
  readSession,
  resumeWorkspace,
} from "@/ipc/commands";
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
  workspaceId: string | null;
  sessionId: string | null;
  model: string | null;
  slashCommands: string[];
  cost: number | null;
  usage: Usage | null;
  error: string | null;
  truncated: boolean;
  /** A queued resume/fork the next `send` should open with, instead of a fresh session. */
  pendingOpen: { resume: string; fork: boolean } | null;
  send: (prompt: string) => Promise<void>;
  cancel: () => Promise<void>;
  /** Re-enter a past session: tears down the live child, loads history, queues a resume. */
  resume: (sessionId: string, fork?: boolean) => Promise<void>;
  /** Drop the current session and start a fresh conversation on the next turn. */
  newSession: () => void;
}

export const useConversation = create<ConversationState>((set, get) => {
  // Module-local cursors (not reactive state): which assistant bubble is
  // currently accumulating deltas. Reset on tool calls and turn boundaries so a
  // post-tool reply renders as a new bubble.
  let assistantSeq = 0;
  let currentAssistantId: string | null = null;
  // Bumped on every session switch (resume / fork / new). Events from a torn-down
  // session (e.g. the late `Stopped` a closing child emits on EOF) carry a stale
  // epoch and are dropped, so they can't bleed into the new session's turn.
  let epoch = 0;

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

        case "result": {
          // The turn's terminal event. On an error result (e.g. a mid-turn
          // failure) mark the live bubble stopped — capture its id before reset.
          const aid = currentAssistantId;
          currentAssistantId = null;
          return {
            streaming: false,
            cost: ev.total_cost_usd ?? s.cost,
            usage: ev.usage,
            sessionId: ev.session_id,
            items:
              ev.is_error && aid
                ? s.items.map((it) =>
                    it.id === aid && it.kind === "assistant" ? { ...it, stopped: true } : it,
                  )
                : s.items,
          };
        }

        case "stopped": {
          const aid = currentAssistantId;
          currentAssistantId = null;
          return {
            streaming: false,
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

  // Wrap `dispatch` so only events from the still-current session are applied.
  const channelFor = (boundEpoch: number) => (ev: EngineEvent) => {
    if (boundEpoch === epoch) dispatch(ev);
  };

  return {
    items: [],
    streaming: false,
    workspaceId: null,
    sessionId: null,
    model: null,
    slashCommands: [],
    cost: null,
    usage: null,
    error: null,
    truncated: false,
    pendingOpen: null,

    send: async (prompt: string) => {
      const text = prompt.trim();
      if (!text || get().streaming) return;
      currentAssistantId = null;
      // `streaming` flips synchronously here, so a second send is blocked until
      // the turn ends — which also prevents opening the session twice.
      set((s) => ({
        items: [...s.items, { kind: "user", id: `u-${Date.now()}`, text }],
        streaming: true,
        error: null,
      }));
      try {
        // Lazily open one persistent session; subscribe `dispatch` once. Events
        // (init, deltas, result) flow over that channel for every later turn. A
        // queued resume/fork opens that conversation instead of a fresh one.
        let wsId = get().workspaceId;
        if (!wsId) {
          const pending = get().pendingOpen;
          const onEvent = channelFor(epoch);
          wsId = pending
            ? await resumeWorkspace(onEvent, pending.resume, pending.fork)
            : await openWorkspace(onEvent);
          set({ workspaceId: wsId, pendingOpen: null });
        }
        await engineSend(wsId, text);
      } catch (e) {
        // A failed send means the session is unusable; drop it so the next
        // attempt opens a fresh one, and reap the child if one was spawned.
        const wsId = get().workspaceId;
        if (wsId) void closeWorkspace(wsId).catch(() => {});
        set({
          streaming: false,
          workspaceId: null,
          error: isIpcError(e) ? e.message : "Failed to send the turn",
        });
      }
    },

    cancel: async () => {
      const wsId = get().workspaceId;
      if (!wsId || !get().streaming) return;
      try {
        await engineCancel(wsId);
      } catch {
        /* best-effort; the turn will also end on its own */
      }
    },

    resume: async (sessionId: string, fork = false) => {
      const cur = get();
      if (cur.streaming) return; // never switch sessions mid-turn
      // Re-entering the already-active session is a no-op (a fork always proceeds).
      if (!fork && cur.sessionId === sessionId && cur.workspaceId) return;
      // Invalidate the old session's channel, then tear down its child; the
      // resume opens a fresh one on the next turn.
      epoch += 1;
      if (cur.workspaceId) void closeWorkspace(cur.workspaceId).catch(() => {});
      currentAssistantId = null;
      set({
        items: [],
        streaming: false,
        error: null,
        workspaceId: null,
        // Plain resume keeps the id (rail highlights it now); a fork's new id
        // arrives with the first turn's `init`.
        sessionId: fork ? null : sessionId,
        model: null,
        cost: null,
        usage: null,
        truncated: false,
        pendingOpen: { resume: sessionId, fork },
      });
      try {
        const t = await readSession(sessionId);
        // Apply only if this resume is still the current intent (guards against a
        // second click superseding a slow transcript read).
        set((s) =>
          s.pendingOpen?.resume === sessionId ? { items: t.items, truncated: t.truncated } : {},
        );
      } catch (e) {
        set({ error: isIpcError(e) ? e.message : "Could not load that session's history" });
      }
    },

    newSession: () => {
      const cur = get();
      if (cur.streaming) return;
      epoch += 1;
      if (cur.workspaceId) void closeWorkspace(cur.workspaceId).catch(() => {});
      currentAssistantId = null;
      set({
        items: [],
        streaming: false,
        error: null,
        workspaceId: null,
        sessionId: null,
        model: null,
        cost: null,
        usage: null,
        truncated: false,
        pendingOpen: null,
      });
    },
  };
});
