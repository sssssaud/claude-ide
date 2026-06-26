/*
 * Theme store (Phase 10). The user picks a theme; we resolve it to a concrete
 * palette and set `data-theme` on <html>, which re-themes the whole app via the
 * token overrides in `styles/tokens.css`. The choice persists across reloads,
 * and "system" follows the OS light/dark preference live. The resolved `palette`
 * also drives the Monaco editor theme (see `monacoSetup.ts`).
 *
 * The palette is applied as a side-effect when this module is first imported, so
 * the chosen theme is in place as early as the first component that touches it.
 */

import { create } from "zustand";

/** What the user selects. `system` follows the OS preference. */
export type ThemeChoice = "dark" | "midnight" | "light" | "system";
/** A concrete palette `data-theme` value. */
export type Palette = "dark" | "midnight" | "light";

const STORAGE_KEY = "ide:theme";

export const THEME_OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "midnight", label: "Midnight" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
];

function systemPalette(): Palette {
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

function resolve(choice: ThemeChoice): Palette {
  return choice === "system" ? systemPalette() : choice;
}

function apply(palette: Palette) {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = palette;
  }
}

function loadChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "dark" || v === "midnight" || v === "light" || v === "system") return v;
  } catch {
    /* storage unavailable */
  }
  return "dark";
}

interface ThemeState {
  /** The user's selection (persisted). */
  choice: ThemeChoice;
  /** The concrete palette currently applied (resolves `system`). */
  palette: Palette;
  setChoice: (choice: ThemeChoice) => void;
}

export const useTheme = create<ThemeState>((set, get) => {
  const choice = loadChoice();
  const palette = resolve(choice);
  apply(palette);

  // Follow the OS preference live while on "system".
  if (typeof window !== "undefined") {
    const mq = window.matchMedia?.("(prefers-color-scheme: light)");
    mq?.addEventListener?.("change", () => {
      if (get().choice !== "system") return;
      const next = systemPalette();
      apply(next);
      set({ palette: next });
    });
  }

  return {
    choice,
    palette,
    setChoice: (choice) => {
      try {
        localStorage.setItem(STORAGE_KEY, choice);
      } catch {
        /* storage unavailable — selection just won't persist */
      }
      const palette = resolve(choice);
      apply(palette);
      set({ choice, palette });
    },
  };
});
