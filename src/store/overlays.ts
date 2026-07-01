/*
 * Visibility for the two global fuzzy overlays (Addendum II §S3): the Command
 * Palette and Quick Open. A tiny store (not component state) because both are
 * opened from the global keybinding dispatcher, outside the overlays' own
 * component tree.
 */

import { create } from "zustand";

interface OverlaysState {
  palette: boolean;
  quickOpen: boolean;
  openPalette: () => void;
  closePalette: () => void;
  openQuickOpen: () => void;
  closeQuickOpen: () => void;
}

export const useOverlays = create<OverlaysState>((set) => ({
  palette: false,
  quickOpen: false,
  openPalette: () => set({ palette: true, quickOpen: false }),
  closePalette: () => set({ palette: false }),
  openQuickOpen: () => set({ quickOpen: true, palette: false }),
  closeQuickOpen: () => set({ quickOpen: false }),
}));
