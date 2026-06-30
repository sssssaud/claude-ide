/*
 * Layout store (spec 4.4, Phase 5). Tracks which of the three toggleable regions
 * are visible — the Sessions rail (left), the Editor (right), and the Terminal
 * drawer (bottom). The Conversation hero is the center of gravity and is never
 * hidden, so it isn't tracked here. Visibility is the source of truth for the
 * top-bar toggles and the keyboard shortcuts; `WorkspaceShell` reconciles the
 * resizable panels to it. The chosen layout persists across reloads (VS Code-style).
 */

import { create } from "zustand";

/** The regions a user can show/hide. The conversation hero is always present. */
export type Region = "sessions" | "editor" | "terminal";

const STORAGE_KEY = "ide:panels";

type Visibility = Record<Region, boolean>;

const DEFAULTS: Visibility = { sessions: true, editor: true, terminal: true };

function load(): Visibility {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const saved = JSON.parse(raw) as Partial<Visibility>;
    // Only trust known boolean keys; fall back to the default for anything else
    // (so a corrupt or stale payload can never hide a region with no way back).
    return {
      sessions: typeof saved.sessions === "boolean" ? saved.sessions : DEFAULTS.sessions,
      editor: typeof saved.editor === "boolean" ? saved.editor : DEFAULTS.editor,
      terminal: typeof saved.terminal === "boolean" ? saved.terminal : DEFAULTS.terminal,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function persist(v: Visibility) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable (private mode / quota) — visibility just won't persist */
  }
}

interface LayoutState extends Visibility {
  /** Whether the full-area Settings view is open over the workspace (ephemeral —
   *  like VS Code, the settings tab doesn't persist across restarts). */
  settingsOpen: boolean;
  /** Flip one region's visibility. */
  toggle: (region: Region) => void;
  /** Set one region's visibility explicitly (used to sync a drag-to-collapse). */
  setVisible: (region: Region, visible: boolean) => void;
  /** Open / close / toggle the Settings view. */
  openSettings: () => void;
  closeSettings: () => void;
  toggleSettings: () => void;
}

export const useLayout = create<LayoutState>((set) => ({
  ...load(),
  settingsOpen: false,

  toggle: (region) =>
    set((s) => {
      const next = { ...s, [region]: !s[region] };
      persist({ sessions: next.sessions, editor: next.editor, terminal: next.terminal });
      return { [region]: next[region] } as Pick<LayoutState, Region>;
    }),

  setVisible: (region, visible) =>
    set((s) => {
      if (s[region] === visible) return s;
      const next = { ...s, [region]: visible };
      persist({ sessions: next.sessions, editor: next.editor, terminal: next.terminal });
      return { [region]: visible } as Pick<LayoutState, Region>;
    }),

  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),
}));
