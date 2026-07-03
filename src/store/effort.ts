/*
 * Session effort selection (Addendum III §S14). The reasoning-effort level the
 * next `claude` session is spawned with, via the CLI's own `--effort` flag
 * (levels verified against `claude --help`: low/medium/high/xhigh/max).
 * "Default" passes no flag, letting the CLI pick. Mirrors `store/model.ts` —
 * persisted, applies to the next session opened (effort is fixed at spawn).
 */

import { create } from "zustand";

/** `value` is the `--effort` level ("" = CLI default, no flag passed). */
export const EFFORTS: { value: string; label: string }[] = [
  { value: "", label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "X-High" },
  { value: "max", label: "Max" },
];

const KEY = "ide:session-effort";
const VALID = new Set(EFFORTS.map((e) => e.value));

function load(): string {
  try {
    const raw = localStorage.getItem(KEY);
    return raw != null && VALID.has(raw) ? raw : "";
  } catch {
    return "";
  }
}

interface EffortState {
  /** The `--effort` value for the next session ("" = CLI default). */
  effort: string;
  setEffort: (effort: string) => void;
}

export const useEffort = create<EffortState>((set) => ({
  effort: load(),
  setEffort: (effort) => {
    const next = VALID.has(effort) ? effort : "";
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* storage unavailable — the choice just won't persist */
    }
    set({ effort: next });
  },
}));
