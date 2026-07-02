/*
 * Conversation store (spec 2.5, 5.A.1). Derived, read-only mirror of the engine
 * event stream: it consumes `EngineEvent`s and builds an id-keyed list of
 * conversation items. Rendering keys off these ids; unknown event types are
 * ignored (newer-CLI tolerance, spec 2.3).
 */

import { createStore, useStore, type StoreApi } from "zustand";
import {
  approvePermission,
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
      /** `awaiting` = the CLI is blocked on a permission decision (P1). */
      status: "running" | "awaiting" | "done";
      /** Present while a permission decision is pending/just made (P1, spec 3.6). */
      perm?: { requestId: string; decided?: "allow" | "deny" };
    };

/** Bound on `rawLog` (Addendum II §S6, BottomPanel's Output/Logs tab) — a
 *  rolling window, not a full transcript (that's what session history/resume is
 *  for). */
const RAW_LOG_LIMIT = 500;

function appendRawLog(log: EngineEvent[], ev: EngineEvent): EngineEvent[] {
  const next = [...log, ev];
  return next.length > RAW_LOG_LIMIT ? next.slice(next.length - RAW_LOG_LIMIT) : next;
}

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
  /** Every raw engine event received, most recent last, capped at
   *  `RAW_LOG_LIMIT` (Addendum II §S6) — including events from a
   *  since-superseded session, which `items` deliberately drops. Powers the
   *  Bottom Panel's Output/Logs tab; not derived from `items` since the
   *  point is to see what the CLI actually sent, unfiltered. */
  rawLog: EngineEvent[];
  /** A queued resume/fork the next `send` should open with, instead of a fresh session. */
  pendingOpen: { resume: string; fork: boolean } | null;
  /** A pending prompt-bar insert request — e.g. "re-run" a past prompt found
   *  via cross-session search (Addendum II §S7). The prompt bar consumes this
   *  once (populating the composer for review) and clears it; never auto-sent. */
  draftInsert: string | null;
  insertDraft: (text: string) => void;
  clearDraftInsert: () => void;
  send: (prompt: string) => Promise<void>;
  cancel: () => Promise<void>;
  /**
   * Answer a pending tool-permission request (P1 review queue). `toolId` is the
   * tool card's id (== the CLI's `tool_use_id`); `updatedInput` (allow only)
   * lets the user run an edited version of the proposed input. Resolves the
   * blocked turn so the agent continues.
   */
  resolvePermission: (
    toolId: string,
    decision: "allow" | "deny",
    updatedInput?: unknown,
  ) => Promise<void>;
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

        case "permission_request": {
          // The agent wants to run a tool that needs approval (spec 3.6). The
          // `tool_use` for it always arrives first, so attach the pending
          // decision to that card (status → awaiting). If — defensively — no
          // card exists yet, create one so the request is never lost.
          turnProducedOutput = true;
          const perm = { requestId: ev.request_id };
          const exists = s.items.some(
            (it) => it.kind === "tool" && it.id === ev.tool_use_id,
          );
          if (exists) {
            return {
              items: s.items.map((it) =>
                it.kind === "tool" && it.id === ev.tool_use_id
                  ? { ...it, input: ev.input, status: "awaiting", perm }
                  : it,
              ),
            };
          }
          return {
            items: [
              ...s.items,
              {
                kind: "tool",
                id: ev.tool_use_id,
                name: ev.tool,
                input: ev.input,
                status: "awaiting",
                perm,
              },
            ],
          };
        }

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
            items: withCommandNotice(settleAwaiting(base)),
          };
        }

        case "stopped": {
          const aid = currentAssistantId;
          currentAssistantId = null;
          const base = s.items.map((it) =>
            it.id === aid && it.kind === "assistant" ? { ...it, stopped: true } : it,
          );
          return { streaming: false, items: withCommandNotice(settleAwaiting(base)) };
        }

        default:
          return {}; // unknown event type from a newer CLI: ignore, never crash
      }
    });
  };

  // A turn that ends (interrupt, or a terminal result) while a permission card
  // is still `awaiting` means the decision was never made — the CLI has moved
  // on. Settle those cards so their live Approve/Reject buttons can't fire a
  // response for an abandoned request (fail-safe: the tool never ran).
  const settleAwaiting = (items: ConvItem[]): ConvItem[] =>
    items.map((it) =>
      it.kind === "tool" && it.status === "awaiting"
        ? { ...it, status: "done", isError: true, output: "(not run — turn ended)", perm: undefined }
        : it,
    );

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
  // The raw log records every event that arrives here regardless of epoch —
  // it's a debug trace of what the CLI sent, not of what got applied.
  const channelFor = (boundEpoch: number) => (ev: EngineEvent) => {
    set((s) => ({ rawLog: appendRawLog(s.rawLog, ev) }));
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
    rawLog: [],
    pendingOpen: null,
    draftInsert: null,

    insertDraft: (text) => set({ draftInsert: text }),
    clearDraftInsert: () => set({ draftInsert: null }),

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

    resolvePermission: async (toolId, decision, updatedInput) => {
      const wsId = get().workspaceId;
      const item = get().items.find((it) => it.kind === "tool" && it.id === toolId);
      if (!wsId || !item || item.kind !== "tool" || item.perm?.decided) return;
      const requestId = item.perm?.requestId;
      if (!requestId) return;
      // Optimistically reflect the decision: the card drops its buttons and goes
      // back to `running` (the CLI will send the tool_result shortly, flipping it
      // to `done`). On allow, show the edited input if one was supplied.
      const input = decision === "allow" ? (updatedInput ?? item.input) : item.input;
      set((s) => ({
        items: s.items.map((it) =>
          it.kind === "tool" && it.id === toolId
            ? { ...it, input, status: "running", perm: { requestId, decided: decision } }
            : it,
        ),
      }));
      try {
        await approvePermission(
          wsId,
          requestId,
          decision,
          decision === "allow" ? input : undefined,
          decision === "deny" ? "Rejected by the user" : undefined,
        );
      } catch (e) {
        // The answer didn't reach the CLI; surface it and leave the turn to the
        // user (the card returns to awaiting so they can retry the decision).
        set((s) => ({
          error: isIpcError(e) ? e.message : "Could not send the permission decision",
          items: s.items.map((it) =>
            it.kind === "tool" && it.id === toolId
              ? { ...it, status: "awaiting", perm: { requestId } }
              : it,
          ),
        }));
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

/** The active workspace's conversation store — for imperative access (e.g. the
 *  agent-bridge commands sending a turn from outside a component). */
export function activeConversationStore(): StoreApi<ConversationState> {
  const id = useWorkspaces.getState().activeId;
  return id ? conversationStoreFor(id) : emptyStore;
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
