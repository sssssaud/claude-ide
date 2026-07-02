/*
 * Visibility for the global overlays (Addendum II §S3, S7): the Command
 * Palette, Quick Open, and the keyboard-shortcut cheat sheet. A tiny store
 * (not component state) because all three are opened from the global
 * keybinding dispatcher (or a dedicated hotkey listener), outside the
 * overlays' own component tree. Mutually exclusive — opening one closes
 * the others.
 */

import { create } from "zustand";

interface OverlaysState {
  palette: boolean;
  quickOpen: boolean;
  cheatSheet: boolean;
  openPalette: () => void;
  closePalette: () => void;
  openQuickOpen: () => void;
  closeQuickOpen: () => void;
  openCheatSheet: () => void;
  closeCheatSheet: () => void;
}

export const useOverlays = create<OverlaysState>((set) => ({
  palette: false,
  quickOpen: false,
  cheatSheet: false,
  openPalette: () => set({ palette: true, quickOpen: false, cheatSheet: false }),
  closePalette: () => set({ palette: false }),
  openQuickOpen: () => set({ quickOpen: true, palette: false, cheatSheet: false }),
  closeQuickOpen: () => set({ quickOpen: false }),
  openCheatSheet: () => set({ cheatSheet: true, palette: false, quickOpen: false }),
  closeCheatSheet: () => set({ cheatSheet: false }),
}));
