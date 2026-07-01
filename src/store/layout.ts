/*
 * Layout store (spec 4.4, Phase 5; Addendum II layout pass). Tracks which of the
 * toggleable regions are visible — the Side panel (the activity-bar's content:
 * Explorer / Search / Source Control / Permissions / Usage / Sessions), the
 * Editor, and the Terminal drawer — plus which side-panel view is selected.
 *
 * The Conversation hero is the center of gravity and is never hidden, so it isn't
 * tracked here. Visibility is the source of truth for the toggles and shortcuts;
 * `WorkspaceShell` reconciles the resizable panels to it. The activity bar itself
 * is always visible (VS Code-style); only its content panel collapses. The chosen
 * layout + the last side-panel view persist across reloads.
 */

import { create } from "zustand";

/** The regions a user can show/hide. The conversation hero is always present, and
 *  the activity bar (icon strip) is always visible — only the side *panel* hides. */
export type Region = "sidebar" | "editor" | "terminal";

/** The side-panel views, selected from the activity bar. */
export type View = "files" | "search" | "git" | "permissions" | "usage" | "sessions";

const STORAGE_KEY = "ide:panels";

type Visibility = Record<Region, boolean>;

const DEFAULTS: Visibility = { sidebar: true, editor: true, terminal: true };
const DEFAULT_VIEW: View = "files";

const VIEW_VALUES: View[] = ["files", "search", "git", "permissions", "usage", "sessions"];

interface Persisted extends Visibility {
  view: View;
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS, view: DEFAULT_VIEW };
    const saved = JSON.parse(raw) as Partial<Persisted>;
    // Only trust known keys; fall back to the default for anything else (so a
    // corrupt or stale payload can never hide a region with no way back).
    return {
      sidebar: typeof saved.sidebar === "boolean" ? saved.sidebar : DEFAULTS.sidebar,
      editor: typeof saved.editor === "boolean" ? saved.editor : DEFAULTS.editor,
      terminal: typeof saved.terminal === "boolean" ? saved.terminal : DEFAULTS.terminal,
      view: VIEW_VALUES.includes(saved.view as View) ? (saved.view as View) : DEFAULT_VIEW,
    };
  } catch {
    return { ...DEFAULTS, view: DEFAULT_VIEW };
  }
}

function persist(p: Persisted) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable (private mode / quota) — layout just won't persist */
  }
}

interface LayoutState extends Visibility {
  /** The currently selected side-panel view (Files / Search / … / Sessions). */
  view: View;
  /** Flip one region's visibility. */
  toggle: (region: Region) => void;
  /** Set one region's visibility explicitly (used to sync a drag-to-collapse). */
  setVisible: (region: Region, visible: boolean) => void;
  /** Select a side-panel view. Selecting the active view while the panel is open
   *  collapses it (VS Code-style); otherwise it opens the panel on that view. */
  selectView: (view: View) => void;
}

export const useLayout = create<LayoutState>((set, get) => {
  const initial = load();
  const snapshot = (s: LayoutState): Persisted => ({
    sidebar: s.sidebar,
    editor: s.editor,
    terminal: s.terminal,
    view: s.view,
  });

  return {
    ...initial,

    toggle: (region) =>
      set((s) => {
        const next = { ...s, [region]: !s[region] };
        persist(snapshot(next));
        return { [region]: next[region] } as Pick<LayoutState, Region>;
      }),

    setVisible: (region, visible) =>
      set((s) => {
        if (s[region] === visible) return s;
        const next = { ...s, [region]: visible };
        persist(snapshot(next));
        return { [region]: visible } as Pick<LayoutState, Region>;
      }),

    selectView: (view) => {
      const s = get();
      // Clicking the active view's icon toggles the panel; any other view opens
      // the panel and switches to it.
      if (s.view === view && s.sidebar) {
        const next = { ...s, sidebar: false };
        persist(snapshot(next));
        set({ sidebar: false });
        return;
      }
      const next = { ...s, view, sidebar: true };
      persist(snapshot(next));
      set({ view, sidebar: true });
    },
  };
});
