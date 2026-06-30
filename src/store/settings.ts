/*
 * Settings store (Addendum II §1, S1). The IDE's own preferences, mirrored from
 * the backend's `app_config_dir/settings.json` (never `~/.claude`). Two scopes —
 * a global `user` block and per-workspace overrides keyed by canonical path — and
 * the *effective* value for a workspace is `DEFAULTS < user < workspace`.
 *
 * The store is the read-only mirror of backend truth (like the other stores):
 * `load()` pulls the document; `setEditor()` writes one field for a scope and
 * the backend validates/clamps + persists. Writes send the scope's FULL editor
 * block (the backend treats an absent field as "cleared"), so a reset removes the
 * key. Monaco subscribes to the effective value and re-applies options live.
 */

import { create } from "zustand";
import { readSettings, writeSettings } from "@/ipc/commands";
import { isIpcError, type EditorSettings, type SettingsScope, type WordWrap } from "@/ipc/types";

/** The concrete editor config Monaco needs — every field resolved (no optionals).
 *  This is what `DEFAULTS < user < workspace` produces. */
export interface EffectiveEditor {
  fontFamily: string;
  fontSize: number;
  fontLigatures: boolean;
  wordWrap: WordWrap;
  wordWrapColumn: number;
  tabSize: number;
  insertSpaces: boolean;
  minimap: boolean;
}

/** Frontend defaults — the single source of truth for "unset" (matches the
 *  editor's prior hardcoded options so behaviour is unchanged until overridden).
 *  `var(--font-mono)` resolves through Monaco's CSS, keeping fonts token-driven. */
export const EDITOR_DEFAULTS: EffectiveEditor = {
  fontFamily: "var(--font-mono)",
  fontSize: 15,
  fontLigatures: false,
  wordWrap: "off",
  wordWrapColumn: 80,
  tabSize: 2,
  insertSpaces: true,
  minimap: false,
};

/** Merge `DEFAULTS < user < workspace` into a fully-resolved editor config. A
 *  field is taken from the highest scope that explicitly set it. */
export function mergeEffective(
  user: EditorSettings,
  workspace: EditorSettings | undefined,
): EffectiveEditor {
  const pick = <K extends keyof EditorSettings>(key: K): NonNullable<EditorSettings[K]> => {
    const w = workspace?.[key];
    if (w !== undefined && w !== null) return w as NonNullable<EditorSettings[K]>;
    const u = user[key];
    if (u !== undefined && u !== null) return u as NonNullable<EditorSettings[K]>;
    return EDITOR_DEFAULTS[key] as unknown as NonNullable<EditorSettings[K]>;
  };
  return {
    fontFamily: pick("fontFamily"),
    fontSize: pick("fontSize"),
    fontLigatures: pick("fontLigatures"),
    wordWrap: pick("wordWrap"),
    wordWrapColumn: pick("wordWrapColumn"),
    tabSize: pick("tabSize"),
    insertSpaces: pick("insertSpaces"),
    minimap: pick("minimap"),
  };
}

interface SettingsState {
  /** Whether the backend document has been loaded at least once. */
  loaded: boolean;
  /** A load failure message (shows the Settings view's error state). */
  loadError: string | null;
  /** A save failure message (shown inline; the optimistic change is rolled back). */
  saveError: string | null;
  /** Raw partials straight from the file (an absent field = "not overridden"). */
  user: EditorSettings;
  workspaces: Record<string, EditorSettings>;
  /** Which scope the Settings view is currently editing. */
  scope: SettingsScope;

  setScope: (scope: SettingsScope) => void;
  /** Pull the whole document from the backend (idempotent; safe to call on mount). */
  load: () => Promise<void>;
  /**
   * Set (or, with `value === undefined`, clear) one editor field in a scope and
   * persist. `workspaceKey` (the canonical cwd) is required for "workspace" scope.
   */
  setEditor: <K extends keyof EditorSettings>(
    scope: SettingsScope,
    key: K,
    value: EditorSettings[K] | undefined,
    workspaceKey?: string,
  ) => Promise<void>;
  /** Replace a scope's whole editor block (backs the Edit-as-JSON apply). */
  replaceEditor: (
    scope: SettingsScope,
    editor: EditorSettings,
    workspaceKey?: string,
  ) => Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  loaded: false,
  loadError: null,
  saveError: null,
  user: {},
  workspaces: {},
  scope: "user",

  setScope: (scope) => set({ scope }),

  load: async () => {
    try {
      const doc = await readSettings();
      set({
        loaded: true,
        loadError: null,
        user: doc.user?.editor ?? {},
        workspaces: Object.fromEntries(
          Object.entries(doc.workspaces ?? {}).map(([k, v]) => [k, v.editor ?? {}]),
        ),
      });
    } catch (e) {
      set({ loaded: true, loadError: isIpcError(e) ? e.message : "Could not load settings" });
    }
  },

  setEditor: async (scope, key, value, workspaceKey) => {
    const prev = get();
    const base: EditorSettings =
      scope === "user" ? prev.user : (workspaceKey ? prev.workspaces[workspaceKey] : undefined) ?? {};

    // Build the next full editor block: set the field, or drop it when clearing.
    const next: EditorSettings = { ...base };
    if (value === undefined || value === null) delete next[key];
    else next[key] = value;

    await get().replaceEditor(scope, next, workspaceKey);
  },

  replaceEditor: async (scope, editor, workspaceKey) => {
    if (scope === "workspace" && !workspaceKey) {
      set({ saveError: "No workspace is open to scope this setting to." });
      return;
    }
    const prev = get();

    // Optimistic update so Monaco reflects the change immediately.
    if (scope === "user") set({ user: editor, saveError: null });
    else set({ workspaces: { ...prev.workspaces, [workspaceKey as string]: editor }, saveError: null });

    try {
      await writeSettings(scope, editor, workspaceKey);
    } catch (e) {
      // Roll back to backend truth and surface the reason.
      set({ saveError: isIpcError(e) ? e.message : "Could not save the setting" });
      await get().load();
    }
  },
}));
