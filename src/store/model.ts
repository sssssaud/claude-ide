/*
 * Session model selection (Addendum III §S14, feature 2/4). The model the next
 * `claude` session is spawned with, via the CLI's own `--model` flag (aliases
 * verified against `claude --help`: opus / sonnet / haiku / fable, or a full
 * `claude-*` id). "Default" passes no flag, letting the CLI pick.
 *
 * Persisted to localStorage (unlike the ephemeral zoom store): picking a
 * cheaper model — e.g. Sonnet for routine/testing turns — is a deliberate
 * preference that should survive a relaunch. It applies to the NEXT session
 * opened (sessions start lazily on the first turn), not a live one; the picker
 * says so when a session is already running.
 */

import { create } from "zustand";

/** `value` is the `--model` alias ("" = CLI default, no flag passed); the alias
 *  always resolves to the latest of that tier, so labels carry the current
 *  version for clarity (accurate as of 2026-07). The live session's *actual*
 *  model id is shown separately from its `init` event, so this can't silently
 *  mislead if a tier bumps. */
export const MODELS: { value: string; label: string }[] = [
  { value: "", label: "Default" },
  { value: "opus", label: "Opus 4.8" },
  { value: "sonnet", label: "Sonnet 5" },
  { value: "haiku", label: "Haiku 4.5" },
  { value: "fable", label: "Fable 5" },
];

const KEY = "ide:session-model";
const VALID = new Set(MODELS.map((m) => m.value));

function load(): string {
  try {
    const raw = localStorage.getItem(KEY);
    return raw != null && VALID.has(raw) ? raw : "";
  } catch {
    return "";
  }
}

interface ModelState {
  /** The `--model` value for the next session ("" = CLI default). */
  model: string;
  setModel: (model: string) => void;
}

export const useModel = create<ModelState>((set) => ({
  model: load(),
  setModel: (model) => {
    const next = VALID.has(model) ? model : "";
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* storage unavailable — the choice just won't persist */
    }
    set({ model: next });
  },
}));

/** The label for a stored model value (falls back to the raw value). */
export function modelLabel(value: string): string {
  return MODELS.find((m) => m.value === value)?.label ?? value;
}
