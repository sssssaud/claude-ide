/*
 * Keybinding overrides (Addendum II §S6). Command id -> combo string, always
 * user-global (never per-workspace) and persisted immediately on every change —
 * unlike `store/settings.ts`'s staged Apply, there's no draft here: each rebind
 * or reset is one round trip, matching a VS Code-style keybindings editor.
 * Values are plain combo strings, never executable — the dispatcher
 * (`layout/useLayoutShortcuts.ts`) only ever looks one up and compares it to a
 * keydown; it's data, not code (spec §5.6).
 */

import { create } from "zustand";
import { readSettings, writeKeybindings } from "@/ipc/commands";
import { isIpcError, type Keybindings } from "@/ipc/types";

interface KeybindingsState {
  loaded: boolean;
  loadError: string | null;
  saveError: string | null;
  overrides: Keybindings;

  load: () => Promise<void>;
  /** Set (or replace) one command's override combo. */
  setOverride: (commandId: string, combo: string) => Promise<void>;
  /** Drop the override, reverting the command to its built-in default combo. */
  resetOverride: (commandId: string) => Promise<void>;
}

export const useKeybindings = create<KeybindingsState>((set, get) => ({
  loaded: false,
  loadError: null,
  saveError: null,
  overrides: {},

  load: async () => {
    try {
      const doc = await readSettings();
      set({ loaded: true, loadError: null, overrides: doc.keybindings ?? {} });
    } catch (e) {
      set({ loaded: true, loadError: isIpcError(e) ? e.message : "Could not load keybindings" });
    }
  },

  setOverride: async (commandId, combo) => {
    const prev = get().overrides;
    const next = { ...prev, [commandId]: combo };
    set({ overrides: next, saveError: null });
    try {
      await writeKeybindings(next);
    } catch (e) {
      set({ overrides: prev, saveError: isIpcError(e) ? e.message : "Could not save the keybinding" });
    }
  },

  resetOverride: async (commandId) => {
    const prev = get().overrides;
    const { [commandId]: _removed, ...next } = prev;
    set({ overrides: next, saveError: null });
    try {
      await writeKeybindings(next);
    } catch (e) {
      set({ overrides: prev, saveError: isIpcError(e) ? e.message : "Could not reset the keybinding" });
    }
  },
}));

/** The combo a command actually fires on right now: the override if one is set,
 *  else its built-in default. Read outside React (the dispatcher's hot path). */
export function effectiveCombo(commandId: string, defaultCombo: string | undefined): string | undefined {
  const o = useKeybindings.getState().overrides[commandId];
  return o !== undefined && o !== "" ? o : defaultCombo;
}
