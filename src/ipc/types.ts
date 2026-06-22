/*
 * TypeScript mirror of the backend IPC types (spec 2.3, 2.4).
 *
 * Kept in lockstep with the Rust side by hand. Phase 0 covers preflight, perf,
 * and the error envelope; EngineEvent and the workspace types arrive with their
 * phases.
 */

/** Mirror of Rust `IpcErrorKind`. Grows per phase alongside the Rust enum. */
export type IpcErrorKind = "internal" | "invalid_input";

/** Mirror of Rust `IpcError` — the structured error that crosses IPC. */
export interface IpcError {
  kind: IpcErrorKind;
  message: string;
  detail?: string;
}

/** Mirror of Rust `PreflightReport` (spec 3.10). */
export interface PreflightReport {
  claudeFound: boolean;
  claudePath: string | null;
  version: string | null;
  authenticated: boolean;
  authDetail: string | null;
  ok: boolean;
}

/** Mirror of Rust `PerfStats` (spec 2.7). */
export interface PerfStats {
  coldStartMs: number | null;
  rssBytes: number;
  rssMb: number;
}

/** Mirror of Rust `Usage` (spec 2.3). */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

/**
 * Mirror of Rust `EngineEvent` (spec 2.3) — internally tagged by `type`.
 * Render by `type`, never by position; tolerate unknown `type`s from a newer
 * CLI (they are ignored, never crash the pane). Field names match Rust 1:1.
 */
export type EngineEvent =
  | {
      type: "init";
      session_id: string;
      model: string;
      slash_commands: string[];
      tools: string[];
    }
  | { type: "assistant_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: unknown; is_error: boolean }
  | {
      type: "result";
      is_error: boolean;
      total_cost_usd: number | null;
      usage: Usage;
      session_id: string;
    }
  | { type: "stopped" }
  | { type: "parse_error"; raw: string }
  | { type: "unknown"; kind: string };

/** Type guard for errors thrown by the invoke wrappers. */
export function isIpcError(value: unknown): value is IpcError {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "message" in value
  );
}
