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
 * Send a turn into the engine. `onEvent` is invoked for each streamed
 * `EngineEvent` over a Tauri channel; resolves to the turn id (for cancel).
 */
export async function engineSend(
  prompt: string,
  onEvent: (event: EngineEvent) => void,
): Promise<string> {
  const channel = new Channel<EngineEvent>();
  channel.onmessage = onEvent;
  try {
    return await invoke<string>("engine_send", { prompt, onEvent: channel });
  } catch (e) {
    normalizeError(e);
  }
}

/** Request cancellation of an in-flight turn. */
export async function engineCancel(turnId: string): Promise<void> {
  try {
    await invoke<void>("engine_cancel", { turnId });
  } catch (e) {
    normalizeError(e);
  }
}
