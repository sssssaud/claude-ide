/*
 * Settings store (Addendum II §1, S1 + staged-apply revision). The IDE's own
 * preferences, mirrored from the backend's `app_config_dir/settings.json` (never
 * `~/.claude`). Two scopes — a global `user` block and per-workspace overrides
 * keyed by canonical path — and the *effective* value for a workspace is
 * `DEFAULTS < user < workspace`.
 *
 * Editing is STAGED (the user asked for an explicit Apply): the Settings tab
 * edits a `draft` for the selected scope and nothing changes in the editor until
 * Apply persists it. `dirty` tracks unapplied edits so closing the tab can warn.
 * The editor reads only the *applied* (persisted) values, so staged drafts never
 * leak into Monaco before Apply.
 */

import { create } from "zustand";
import { readSettings, writeSettings } from "@/ipc/commands";
import { SETTINGS_TAB_ID, activeEditorStore } from "@/store/editor";
import { activeCwd } from "@/store/workspaces";
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

/** The editor keys we model, in display order. */
export const EDITOR_KEYS: (keyof EditorSettings)[] = [
  "fontFamily",
  "fontSize",
  "fontLigatures",
  "wordWrap",
  "wordWrapColumn",
  "tabSize",
  "insertSpaces",
  "minimap",
];

/** Merge `DEFAULTS < user < workspace` into a fully-resolved editor config. */
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

/** Shallow equality over the modelled editor keys (drives the dirty flag). */
function editorEqual(a: EditorSettings, b: EditorSettings): boolean {
  return EDITOR_KEYS.every((k) => a[k] === b[k]);
}

interface SettingsState {
  /** Whether the backend document has been loaded at least once. */
  loaded: boolean;
  loadError: string | null;
  saveError: string | null;
  /** Applied (persisted) partials straight from the file. */
  user: EditorSettings;
  workspaces: Record<string, EditorSettings>;
  /** Which scope the Settings tab is editing. */
  scope: SettingsScope;
  /** The staged working copy for `scope` (not yet applied). */
  draft: EditorSettings;
  /** Whether `draft` differs from the applied value for `scope`. */
  dirty: boolean;
  /** Whether the close-confirmation prompt is showing (unapplied changes). */
  confirmingClose: boolean;

  load: () => Promise<void>;
  /** Initialise the draft from the applied value for the current scope. */
  beginEditing: () => void;
  /** Switch scope (blocked while there are unapplied changes). */
  setScope: (scope: SettingsScope) => void;
  /** Stage one field (or clear it with `undefined`); recomputes `dirty`. */
  setDraft: <K extends keyof EditorSettings>(key: K, value: EditorSettings[K] | undefined) => void;
  /** Replace the whole staged block (backs Edit-as-JSON). */
  replaceDraft: (editor: EditorSettings) => void;
  /** Persist the staged draft for the current scope. */
  apply: () => Promise<void>;
  /** Throw away staged edits, back to the applied value. */
  discard: () => void;
  /** Close the Settings tab, prompting first if there are unapplied changes. */
  requestClose: () => void;
  cancelClose: () => void;
  discardAndClose: () => void;
  applyAndClose: () => Promise<void>;
}

/** The applied (persisted) editor block for a scope. */
function appliedFor(s: Pick<SettingsState, "user" | "workspaces" | "scope">): EditorSettings {
  if (s.scope === "user") return s.user;
  const cwd = activeCwd();
  return (cwd ? s.workspaces[cwd] : undefined) ?? {};
}

function closeSettingsTab() {
  activeEditorStore().getState().close(SETTINGS_TAB_ID);
}

export const useSettings = create<SettingsState>((set, get) => ({
  loaded: false,
  loadError: null,
  saveError: null,
  user: {},
  workspaces: {},
  scope: "user",
  draft: {},
  dirty: false,
  confirmingClose: false,

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
      // Re-sync the draft to the freshly-loaded applied value, unless the user
      // is mid-edit (don't clobber unapplied changes).
      if (!get().dirty) set({ draft: { ...appliedFor(get()) } });
    } catch (e) {
      set({ loaded: true, loadError: isIpcError(e) ? e.message : "Could not load settings" });
    }
  },

  beginEditing: () => set((s) => ({ draft: { ...appliedFor(s) }, dirty: false, saveError: null })),

  setScope: (scope) => {
    if (get().dirty) {
      set({ saveError: "Apply or discard your changes before switching scope." });
      return;
    }
    set({ scope, saveError: null });
    set((s) => ({ draft: { ...appliedFor(s) }, dirty: false }));
  },

  setDraft: (key, value) =>
    set((s) => {
      const draft: EditorSettings = { ...s.draft };
      if (value === undefined || value === null) delete draft[key];
      else draft[key] = value;
      return { draft, dirty: !editorEqual(draft, appliedFor(s)), saveError: null };
    }),

  replaceDraft: (editor) =>
    set((s) => ({ draft: editor, dirty: !editorEqual(editor, appliedFor(s)), saveError: null })),

  apply: async () => {
    const { scope, draft } = get();
    const cwd = activeCwd();
    if (scope === "workspace" && !cwd) {
      set({ saveError: "No workspace is open to scope these settings to." });
      return;
    }
    // Optimistically reflect the new applied value so the editor + dirty update.
    const prev = get();
    if (scope === "user") set({ user: draft });
    else set({ workspaces: { ...prev.workspaces, [cwd as string]: draft } });
    set({ dirty: false, saveError: null });
    try {
      await writeSettings(scope, draft, cwd);
    } catch (e) {
      // Roll back to backend truth and surface the reason; stay dirty.
      set({ saveError: isIpcError(e) ? e.message : "Could not save the settings", dirty: true });
      await get().load();
    }
  },

  discard: () => set((s) => ({ draft: { ...appliedFor(s) }, dirty: false, saveError: null })),

  requestClose: () => {
    if (get().dirty) {
      // Make sure the Settings tab is the one showing, so the prompt is visible.
      activeEditorStore().getState().activate(SETTINGS_TAB_ID);
      set({ confirmingClose: true });
    } else {
      closeSettingsTab();
    }
  },

  cancelClose: () => set({ confirmingClose: false }),

  discardAndClose: () => {
    get().discard();
    set({ confirmingClose: false });
    closeSettingsTab();
  },

  applyAndClose: async () => {
    await get().apply();
    if (!get().dirty && !get().saveError) {
      set({ confirmingClose: false });
      closeSettingsTab();
    }
  },
}));
