/*
 * Typed wrappers over Tauri `invoke` (spec 2.4). The rest of the app calls
 * these, never `invoke` directly, so command names and shapes live in one place
 * and errors normalize to `IpcError`.
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import type { EngineEvent, PerfStats, PreflightReport } from "./types";
import { isIpcError } from "./types";

/** Normalize any thrown value into an `IpcError`-shaped object. */
function normalizeError(e: unknown): never {
  if (isIpcError(e)) throw e;
  throw {
    kind: "internal" as const,
    message: typeof e === "string" ? e : "Unexpected error",
    detail: e instanceof Error ? e.message : undefined,
  };
}

/** Probe the installed `claude` CLI: presence, version, auth. */
export async function preflight(): Promise<PreflightReport> {
  try {
    return await invoke<PreflightReport>("preflight");
  } catch (e) {
    normalizeError(e);
  }
}

/** Tell the backend the UI is ready (anchors the cold-start budget). */
export async function reportReady(): Promise<number> {
  try {
    return await invoke<number>("report_ready");
  } catch (e) {
    normalizeError(e);
  }
}

/** Current perf snapshot (cold start + RSS). */
export async function perfStats(): Promise<PerfStats> {
  try {
    return await invoke<PerfStats>("perf_stats");
  } catch (e) {
    normalizeError(e);
  }
}

/**
 * Open a persistent `claude` engine session. `onEvent` is invoked for every
 * streamed `EngineEvent` for the session's whole lifetime (subscribe once);
 * resolves to the workspace id used by the other engine commands. `cwd`
 * defaults to the app's launch directory.
 */
export async function openWorkspace(
  onEvent: (event: EngineEvent) => void,
  cwd?: string,
): Promise<string> {
  const channel = new Channel<EngineEvent>();
  channel.onmessage = onEvent;
  try {
    return await invoke<string>("open_workspace", { cwd, onEvent: channel });
  } catch (e) {
    normalizeError(e);
  }
}

/** Send one turn into a workspace session; responses arrive over its channel. */
export async function engineSend(workspaceId: string, prompt: string): Promise<void> {
  try {
    await invoke<void>("engine_send", { workspaceId, prompt });
  } catch (e) {
    normalizeError(e);
  }
}

/** Interrupt the in-flight turn in a workspace (the session survives). */
export async function engineCancel(workspaceId: string): Promise<void> {
  try {
    await invoke<void>("engine_cancel", { workspaceId });
  } catch (e) {
    normalizeError(e);
  }
}

/** Close a workspace session, reaping its `claude` child. */
export async function closeWorkspace(workspaceId: string): Promise<void> {
  try {
    await invoke<void>("close_workspace", { workspaceId });
  } catch (e) {
    normalizeError(e);
  }
}
