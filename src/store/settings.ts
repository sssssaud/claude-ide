/*
 * Settings store (Addendum II §1, S1 + staged-apply revision; widened to every
 * category in S6). The IDE's own preferences, mirrored from the backend's
 * `app_config_dir/settings.json` (never `~/.claude`). Two scopes — a global
 * `user` block and per-workspace overrides keyed by canonical path — and the
 * *effective* value for a workspace is `DEFAULTS < user < workspace`.
 *
 * Editing is STAGED (the user asked for an explicit Apply): the Settings tab
 * edits a `draft` (the whole `ScopeSettings` — every category at once) for the
 * selected scope, and nothing changes in the editor/terminal/explorer until
 * Apply persists it. `dirty` tracks unapplied edits so closing the tab can warn.
 * Consumers read only the *applied* (persisted) values, so staged drafts never
 * leak in before Apply.
 */

import { create } from "zustand";
import { readSettings, writeSettings } from "@/ipc/commands";
import { SETTINGS_TAB_ID, activeEditorStore } from "@/store/editor";
import { activeCwd } from "@/store/workspaces";
import {
  isIpcError,
  type AppearanceSettings,
  type AutoSave,
  type Eol,
  type EditorSettings,
  type FilesSettings,
  type ScopeSettings,
  type SettingsScope,
  type TerminalSettings,
  type WordWrap,
} from "@/ipc/types";

// ---- Editor category (Addendum II §1) ---------------------------------------

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
  formatOnSave: boolean;
  formatOnPaste: boolean;
  trimTrailingWhitespace: boolean;
  insertFinalNewline: boolean;
  trimFinalNewlines: boolean;
  autoSave: AutoSave;
  autoSaveDelay: number;
}

/** Frontend defaults — the single source of truth for "unset" (matches the
 *  editor's prior hardcoded options so behaviour is unchanged until overridden).
 *  `var(--font-mono)` resolves through Monaco's CSS, keeping fonts token-driven.
 *  Data-safety defaults (Addendum II §1.2, S2) favour not losing work over
 *  reformatting it: auto-save on focus change, trailing whitespace trimmed
 *  (Markdown excluded elsewhere — trailing spaces are a hard break there),
 *  a trailing newline kept; format-on-save/paste are opt-in since a registered
 *  formatter can reflow code the user didn't ask to have touched. */
export const EDITOR_DEFAULTS: EffectiveEditor = {
  fontFamily: "var(--font-mono)",
  fontSize: 15,
  fontLigatures: false,
  wordWrap: "off",
  wordWrapColumn: 80,
  tabSize: 2,
  insertSpaces: true,
  minimap: false,
  formatOnSave: false,
  formatOnPaste: false,
  trimTrailingWhitespace: true,
  insertFinalNewline: true,
  trimFinalNewlines: false,
  autoSave: "onFocusChange",
  autoSaveDelay: 1000,
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
  "formatOnSave",
  "formatOnPaste",
  "trimTrailingWhitespace",
  "insertFinalNewline",
  "trimFinalNewlines",
  "autoSave",
  "autoSaveDelay",
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
    formatOnSave: pick("formatOnSave"),
    formatOnPaste: pick("formatOnPaste"),
    trimTrailingWhitespace: pick("trimTrailingWhitespace"),
    insertFinalNewline: pick("insertFinalNewline"),
    trimFinalNewlines: pick("trimFinalNewlines"),
    autoSave: pick("autoSave"),
    autoSaveDelay: pick("autoSaveDelay"),
  };
}

// ---- Terminal category (Addendum II §S6) ------------------------------------

export interface EffectiveTerminal {
  fontFamily: string;
  fontSize: number;
  cursorBlink: boolean;
  scrollback: number;
}

/** Matches the terminal's prior hardcoded xterm options (`BottomPanel.tsx`)
 *  so behaviour is unchanged until overridden. */
export const TERMINAL_DEFAULTS: EffectiveTerminal = {
  fontFamily: "var(--font-mono)",
  fontSize: 14,
  cursorBlink: true,
  scrollback: 5000,
};

export const TERMINAL_KEYS: (keyof TerminalSettings)[] = [
  "fontFamily",
  "fontSize",
  "cursorBlink",
  "scrollback",
];

export function mergeEffectiveTerminal(
  user: TerminalSettings,
  workspace: TerminalSettings | undefined,
): EffectiveTerminal {
  const pick = <K extends keyof TerminalSettings>(key: K): NonNullable<TerminalSettings[K]> => {
    const w = workspace?.[key];
    if (w !== undefined && w !== null) return w as NonNullable<TerminalSettings[K]>;
    const u = user[key];
    if (u !== undefined && u !== null) return u as NonNullable<TerminalSettings[K]>;
    return TERMINAL_DEFAULTS[key] as unknown as NonNullable<TerminalSettings[K]>;
  };
  return {
    fontFamily: pick("fontFamily"),
    fontSize: pick("fontSize"),
    cursorBlink: pick("cursorBlink"),
    scrollback: pick("scrollback"),
  };
}

// ---- Files category (Addendum II §S6) ---------------------------------------

export interface EffectiveFiles {
  exclude: string[];
  eol: Eol;
  confirmCloseUnsaved: boolean;
}

/** `confirmCloseUnsaved` defaults on — data-safety favours a confirmation over
 *  a silently discarded edit (Addendum II §1.2's guiding principle, extended). */
export const FILES_DEFAULTS: EffectiveFiles = {
  exclude: [],
  eol: "auto",
  confirmCloseUnsaved: true,
};

export const FILES_KEYS: (keyof FilesSettings)[] = ["exclude", "eol", "confirmCloseUnsaved"];

export function mergeEffectiveFiles(
  user: FilesSettings,
  workspace: FilesSettings | undefined,
): EffectiveFiles {
  const pick = <K extends keyof FilesSettings>(key: K): NonNullable<FilesSettings[K]> => {
    const w = workspace?.[key];
    if (w !== undefined && w !== null) return w as NonNullable<FilesSettings[K]>;
    const u = user[key];
    if (u !== undefined && u !== null) return u as NonNullable<FilesSettings[K]>;
    return FILES_DEFAULTS[key] as unknown as NonNullable<FilesSettings[K]>;
  };
  return {
    exclude: pick("exclude"),
    eol: pick("eol"),
    confirmCloseUnsaved: pick("confirmCloseUnsaved"),
  };
}

// ---- Appearance category (Addendum II §S6) -----------------------------------
// Theme itself stays in `store/theme.ts`, outside this staged-Apply model.

export interface EffectiveAppearance {
  colorFileIcons: boolean;
  reducedMotion: boolean;
}

/** `reducedMotion` defaults off — the OS `prefers-reduced-motion` media query
 *  (honored app-wide already, `global.css`) is the default signal; this setting
 *  is an explicit override to force it on regardless of the OS preference. */
export const APPEARANCE_DEFAULTS: EffectiveAppearance = {
  colorFileIcons: true,
  reducedMotion: false,
};

export const APPEARANCE_KEYS: (keyof AppearanceSettings)[] = ["colorFileIcons", "reducedMotion"];

export function mergeEffectiveAppearance(
  user: AppearanceSettings,
  workspace: AppearanceSettings | undefined,
): EffectiveAppearance {
  const pick = <K extends keyof AppearanceSettings>(
    key: K,
  ): NonNullable<AppearanceSettings[K]> => {
    const w = workspace?.[key];
    if (w !== undefined && w !== null) return w as NonNullable<AppearanceSettings[K]>;
    const u = user[key];
    if (u !== undefined && u !== null) return u as NonNullable<AppearanceSettings[K]>;
    return APPEARANCE_DEFAULTS[key] as unknown as NonNullable<AppearanceSettings[K]>;
  };
  return {
    colorFileIcons: pick("colorFileIcons"),
    reducedMotion: pick("reducedMotion"),
  };
}

// ---- Whole-scope helpers ------------------------------------------------------

function emptyScope(): ScopeSettings {
  return { editor: {}, terminal: {}, files: {}, appearance: {} };
}

/** Defensive: fill in any category the backend omitted (shouldn't happen — every
 *  category always serializes, even empty — but never trust IPC blindly). */
function toScope(raw: Partial<ScopeSettings> | undefined): ScopeSettings {
  return {
    editor: raw?.editor ?? {},
    terminal: raw?.terminal ?? {},
    files: raw?.files ?? {},
    appearance: raw?.appearance ?? {},
  };
}

function cloneScope(s: ScopeSettings): ScopeSettings {
  return {
    editor: { ...s.editor },
    terminal: { ...s.terminal },
    files: { ...s.files, exclude: s.files.exclude ? [...s.files.exclude] : undefined },
    appearance: { ...s.appearance },
  };
}

function fieldEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/** Shallow equality over every modelled key, across every category (drives the
 *  dirty flag). */
function scopeEqual(a: ScopeSettings, b: ScopeSettings): boolean {
  return (
    EDITOR_KEYS.every((k) => fieldEqual(a.editor[k], b.editor[k])) &&
    TERMINAL_KEYS.every((k) => fieldEqual(a.terminal[k], b.terminal[k])) &&
    FILES_KEYS.every((k) => fieldEqual(a.files[k], b.files[k])) &&
    APPEARANCE_KEYS.every((k) => fieldEqual(a.appearance[k], b.appearance[k]))
  );
}

/** Filter a parsed JSON blob down to known keys per category — backs Edit-as-JSON.
 *  Unknown top-level or per-category keys are dropped, not persisted. */
export function sanitizeScopeSettings(parsed: Record<string, unknown>): ScopeSettings {
  const pick = <T extends object>(raw: unknown, keys: (keyof T)[]): T => {
    const src = (
      typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}
    ) as Record<string, unknown>;
    const out = {} as Record<string, unknown>;
    for (const k of keys) {
      const v = src[k as string];
      if (v !== undefined && v !== null) out[k as string] = v;
    }
    return out as T;
  };
  return {
    editor: pick<EditorSettings>(parsed.editor, EDITOR_KEYS),
    terminal: pick<TerminalSettings>(parsed.terminal, TERMINAL_KEYS),
    files: pick<FilesSettings>(parsed.files, FILES_KEYS),
    appearance: pick<AppearanceSettings>(parsed.appearance, APPEARANCE_KEYS),
  };
}

// ---- The store ----------------------------------------------------------------

interface SettingsState {
  /** Whether the backend document has been loaded at least once. */
  loaded: boolean;
  loadError: string | null;
  saveError: string | null;
  /** Applied (persisted) scopes straight from the file. */
  user: ScopeSettings;
  workspaces: Record<string, ScopeSettings>;
  /** Which scope the Settings tab is editing. */
  scope: SettingsScope;
  /** The staged working copy for `scope` — every category — not yet applied. */
  draft: ScopeSettings;
  /** Whether `draft` differs from the applied value for `scope`. */
  dirty: boolean;
  /** Whether the close-confirmation prompt is showing (unapplied changes). */
  confirmingClose: boolean;

  load: () => Promise<void>;
  /** Initialise the draft from the applied value for the current scope. */
  beginEditing: () => void;
  /** Switch scope (blocked while there are unapplied changes). */
  setScope: (scope: SettingsScope) => void;
  /** Stage one field in one category (or clear it with `undefined`); recomputes
   *  `dirty`. */
  setDraft: <C extends keyof ScopeSettings, K extends keyof ScopeSettings[C]>(
    category: C,
    key: K,
    value: ScopeSettings[C][K] | undefined,
  ) => void;
  /** Replace the whole staged draft — every category (backs Edit-as-JSON). */
  replaceDraft: (settings: ScopeSettings) => void;
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

/** The applied (persisted) scope for the currently-selected scope. */
function appliedFor(s: Pick<SettingsState, "user" | "workspaces" | "scope">): ScopeSettings {
  if (s.scope === "user") return s.user;
  const cwd = activeCwd();
  return (cwd ? s.workspaces[cwd] : undefined) ?? emptyScope();
}

function closeSettingsTab() {
  activeEditorStore().getState().close(SETTINGS_TAB_ID);
}

export const useSettings = create<SettingsState>((set, get) => ({
  loaded: false,
  loadError: null,
  saveError: null,
  user: emptyScope(),
  workspaces: {},
  scope: "user",
  draft: emptyScope(),
  dirty: false,
  confirmingClose: false,

  load: async () => {
    try {
      const doc = await readSettings();
      set({
        loaded: true,
        loadError: null,
        user: toScope(doc.user),
        workspaces: Object.fromEntries(
          Object.entries(doc.workspaces ?? {}).map(([k, v]) => [k, toScope(v)]),
        ),
      });
      // Re-sync the draft to the freshly-loaded applied value, unless the user
      // is mid-edit (don't clobber unapplied changes).
      if (!get().dirty) set({ draft: cloneScope(appliedFor(get())) });
    } catch (e) {
      set({ loaded: true, loadError: isIpcError(e) ? e.message : "Could not load settings" });
    }
  },

  beginEditing: () =>
    set((s) => ({ draft: cloneScope(appliedFor(s)), dirty: false, saveError: null })),

  setScope: (scope) => {
    if (get().dirty) {
      set({ saveError: "Apply or discard your changes before switching scope." });
      return;
    }
    set({ scope, saveError: null });
    set((s) => ({ draft: cloneScope(appliedFor(s)), dirty: false }));
  },

  setDraft: (category, key, value) =>
    set((s) => {
      const categoryDraft = { ...s.draft[category] } as Record<string, unknown>;
      if (value === undefined || value === null) delete categoryDraft[key as string];
      else categoryDraft[key as string] = value;
      const draft = { ...s.draft, [category]: categoryDraft } as ScopeSettings;
      return { draft, dirty: !scopeEqual(draft, appliedFor(s)), saveError: null };
    }),

  replaceDraft: (settings) =>
    set((s) => ({ draft: settings, dirty: !scopeEqual(settings, appliedFor(s)), saveError: null })),

  apply: async () => {
    const { scope, draft } = get();
    const cwd = activeCwd();
    if (scope === "workspace" && !cwd) {
      set({ saveError: "No workspace is open to scope these settings to." });
      return;
    }
    // Optimistically reflect the new applied value so consumers + dirty update.
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

  discard: () => set((s) => ({ draft: cloneScope(appliedFor(s)), dirty: false, saveError: null })),

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

/** The effective (merged) settings for the active workspace, read outside React
 *  (module-level helpers, imperative call sites like save pipelines). */
export function effectiveFilesFor(cwd: string | undefined): EffectiveFiles {
  const s = useSettings.getState();
  return mergeEffectiveFiles(s.user.files, cwd ? s.workspaces[cwd]?.files : undefined);
}
