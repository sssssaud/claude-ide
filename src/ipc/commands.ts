/*
 * Typed wrappers over Tauri `invoke` (spec 2.4). The rest of the app calls
 * these, never `invoke` directly, so command names and shapes live in one place
 * and errors normalize to `IpcError`.
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  DirEntry,
  EngineEvent,
  FileContents,
  PerfStats,
  PreflightReport,
  SessionMeta,
} from "./types";
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

/**
 * Open a plain shell in a PTY sized `rows`x`cols`. `onData` receives raw shell
 * output as bytes (write straight to xterm); a zero-length chunk is the EOF
 * sentinel (the shell exited). Resolves to the opaque terminal id.
 */
export async function ptyOpen(
  onData: (bytes: Uint8Array) => void,
  rows: number,
  cols: number,
): Promise<string> {
  const channel = new Channel<number[]>();
  channel.onmessage = (msg) => {
    // Rust sends `Vec<u8>`; serde gives a number[]. Tolerate ArrayBuffer/typed
    // arrays in case the transport optimizes binary in a newer Tauri.
    const bytes =
      msg instanceof ArrayBuffer
        ? new Uint8Array(msg)
        : ArrayBuffer.isView(msg as unknown as ArrayBufferView)
          ? new Uint8Array((msg as unknown as ArrayBufferView).buffer)
          : new Uint8Array(msg);
    onData(bytes);
  };
  try {
    return await invoke<string>("pty_open", { rows, cols, onData: channel });
  } catch (e) {
    normalizeError(e);
  }
}

/** Send keystrokes into a terminal. */
export async function ptyWrite(ptyId: string, data: string): Promise<void> {
  try {
    await invoke<void>("pty_write", { ptyId, data });
  } catch (e) {
    normalizeError(e);
  }
}

/** Resize a terminal's PTY to match the drawer. */
export async function ptyResize(ptyId: string, rows: number, cols: number): Promise<void> {
  try {
    await invoke<void>("pty_resize", { ptyId, rows, cols });
  } catch (e) {
    normalizeError(e);
  }
}

/** Close a terminal, reaping its shell. */
export async function ptyClose(ptyId: string): Promise<void> {
  try {
    await invoke<void>("pty_close", { ptyId });
  } catch (e) {
    normalizeError(e);
  }
}

/**
 * List the workspace's `claude` sessions (read-only), newest activity first.
 * `cwd` defaults to the launch / `CLAUDE_IDE_WORKSPACE` directory.
 */
export async function listSessions(cwd?: string): Promise<SessionMeta[]> {
  try {
    return await invoke<SessionMeta[]>("list_sessions", { cwd });
  } catch (e) {
    normalizeError(e);
  }
}

/**
 * Watch for new/removed sessions; `onChange` receives the refreshed list each
 * time the project's session set changes (subscribe once for the app's life).
 */
export async function watchSessions(
  onChange: (sessions: SessionMeta[]) => void,
  cwd?: string,
): Promise<void> {
  const channel = new Channel<SessionMeta[]>();
  channel.onmessage = onChange;
  try {
    await invoke<void>("watch_sessions", { cwd, onChange: channel });
  } catch (e) {
    normalizeError(e);
  }
}

/** List a workspace directory for the file explorer (`path` relative to root). */
export async function listDir(path?: string): Promise<DirEntry[]> {
  try {
    return await invoke<DirEntry[]>("list_dir", { path });
  } catch (e) {
    normalizeError(e);
  }
}

/** Read a workspace file's text for the editor (size-capped, binary-guarded). */
export async function readFile(path: string): Promise<FileContents> {
  try {
    return await invoke<FileContents>("read_file", { path });
  } catch (e) {
    normalizeError(e);
  }
}
