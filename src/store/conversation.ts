/*
 * Conversation store (spec 2.5, 5.A.1). Derived, read-only mirror of the engine
 * event stream: it consumes `EngineEvent`s and builds an id-keyed list of
 * conversation items. Rendering keys off these ids; unknown event types are
 * ignored (newer-CLI tolerance, spec 2.3).
 */

import { createStore, useStore, type StoreApi } from "zustand";
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
import { useWorkspaces } from "@/store/workspaces";

export type ConvItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; stopped?: boolean }
  | { kind: "notice"; id: string; text: string }
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
  /**
   * `claude -c` for the IDE: on a workspace's first focus, continue its most
   * recent session (load history + queue a resume) instead of starting fresh.
   * Idempotent and one-shot per workspace, so a later `+ NEW` is never overridden.
   */
  maybeContinue: (latestSessionId: string) => void;
}

// One conversation store per workspace (Phase 5). The body is identical to the
// single-workspace store it grew from — wrapping it in a factory gives each
// workspace its own fully isolated conversation (items, live `claude` session,
// and the per-turn cursors below are closure-local, so they never bleed across
// workspaces). `cwd` is the workspace root every engine call routes through.
const makeConversationStore = (cwd: string): StoreApi<ConversationState> =>
  createStore<ConversationState>((set, get) => {
  // Module-local cursors (not reactive state): which assistant bubble is
  // currently accumulating deltas. Reset on tool calls and turn boundaries so a
  // post-tool reply renders as a new bubble.
  let assistantSeq = 0;
  let currentAssistantId: string | null = null;
  // Bumped on every session switch (resume / fork / new). Events from a torn-down
  // session (e.g. the late `Stopped` a closing child emits on EOF) carry a stale
  // epoch and are dropped, so they can't bleed into the new session's turn.
  let epoch = 0;
  // A slash-command turn often produces no visible output (an empty synthetic
  // assistant message). We track that per turn so it leaves a `✓ ran /cmd` trace
  // rather than looking like nothing happened.
  let turnIsCommand = false;
  let turnProducedOutput = false;
  let lastCommand: string | null = null;
  let noticeSeq = 0;
  // One-shot guard for the `claude -c` auto-continue: set the first time this
  // workspace is focused (whether or not a prior session existed), so a manual
  // `+ NEW` or resume afterwards is never silently re-continued.
  let autoContinued = false;

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
          turnProducedOutput = true;
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
          turnProducedOutput = true;
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
          const base =
            ev.is_error && aid
              ? s.items.map((it) =>
                  it.id === aid && it.kind === "assistant" ? { ...it, stopped: true } : it,
                )
              : s.items;
          return {
            streaming: false,
            cost: ev.total_cost_usd ?? s.cost,
            usage: ev.usage,
            sessionId: ev.session_id,
            items: withCommandNotice(base),
          };
        }

        case "stopped": {
          const aid = currentAssistantId;
          currentAssistantId = null;
          const base = s.items.map((it) =>
            it.id === aid && it.kind === "assistant" ? { ...it, stopped: true } : it,
          );
          return { streaming: false, items: withCommandNotice(base) };
        }

        default:
          return {}; // unknown event type from a newer CLI: ignore, never crash
      }
    });
  };

  // At a turn boundary, append a `✓ ran /cmd` trace if the turn was a slash
  // command that produced no visible output. Resets the per-turn command flag.
  const withCommandNotice = (items: ConvItem[]): ConvItem[] => {
    const silent = turnIsCommand && !turnProducedOutput && lastCommand;
    turnIsCommand = false;
    return silent
      ? [...items, { kind: "notice", id: `n-${noticeSeq++}`, text: `ran ${lastCommand}` }]
      : items;
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
      // Track slash-command turns so a no-output command still leaves a trace.
      turnIsCommand = text.startsWith("/");
      turnProducedOutput = false;
      lastCommand = turnIsCommand ? text.split(/\s+/)[0] : null;
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
            ? await resumeWorkspace(onEvent, pending.resume, pending.fork, cwd)
            : await openWorkspace(onEvent, cwd);
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
      turnIsCommand = false;
      turnProducedOutput = false;
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
        const t = await readSession(sessionId, cwd);
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
      turnIsCommand = false;
      turnProducedOutput = false;
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

    maybeContinue: (latestSessionId: string) => {
      if (autoContinued) return;
      autoContinued = true; // one-shot, regardless of outcome below
      const cur = get();
      // Only auto-continue a truly pristine workspace; never disturb one the
      // user has already engaged (sent a turn, resumed, or has a live child).
      if (cur.workspaceId || cur.sessionId || cur.pendingOpen || cur.items.length > 0) return;
      void get().resume(latestSessionId);
    },
  };
});

// ---- Per-workspace registry + active-workspace access ----------------------
// id === the workspace's absolute path (also its cwd). Stores are created
// lazily on first use and kept alive across tab switches, so each workspace's
// live `claude` session, history, cost, and in-flight turn all persist — that's
// what makes switching instant with no context bleed.
const stores = new Map<string, StoreApi<ConversationState>>();
// A stable, inert store for the brief pre-bootstrap window when there is no
// active workspace yet (never opened, so it spawns no `claude` process).
const emptyStore = makeConversationStore("");

function conversationStoreFor(id: string): StoreApi<ConversationState> {
  let store = stores.get(id);
  if (!store) {
    store = makeConversationStore(id);
    stores.set(id, store);
  }
  return store;
}

/** Select from the active workspace's conversation. Re-subscribes when the
 *  active workspace changes, so the hero always shows the focused workspace. */
export function useActiveConversation<T>(selector: (s: ConversationState) => T): T {
  const activeId = useWorkspaces((s) => s.activeId);
  return useStore(activeId ? conversationStoreFor(activeId) : emptyStore, selector);
}

// When a workspace tab closes, reap its `claude` session and drop its store so
// no orphan process lingers (spec 2.5 "no zombie"). App-exit teardown reaps
// everything anyway; this just makes a per-tab close prompt.
let knownIds = new Set(useWorkspaces.getState().workspaces.map((w) => w.id));
useWorkspaces.subscribe((state) => {
  const ids = new Set(state.workspaces.map((w) => w.id));
  for (const id of knownIds) {
    if (!ids.has(id)) {
      const wsId = stores.get(id)?.getState().workspaceId;
      if (wsId) void closeWorkspace(wsId).catch(() => {});
      stores.delete(id);
    }
  }
  knownIds = ids;
});
