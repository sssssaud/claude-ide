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

/** `value` is the `--model` alias ("" = CLI default, no flag passed). */
export const MODELS: { value: string; label: string }[] = [
  { value: "", label: "Default" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
  { value: "fable", label: "Fable" },
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
