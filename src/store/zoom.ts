/*
 * Zoom (Addendum II §S3, §2.1). Two independent, EPHEMERAL levels (reset each
 * launch, never persisted, never touch Settings' staged Apply model):
 *  - `editorDelta` nudges the effective editor font size up/down a few steps.
 *  - `uiLevel` scales the whole app via the CSS `zoom` property (WebKit
 *    supports it, which is what this app targets) — mirrors VS Code's
 *    Ctrl+=/Ctrl+-/Ctrl+0 window zoom.
 * Kept ephemeral on purpose: a persisted zoom that silently changes the next
 * launch would be confusing with no on-screen explanation, whereas the
 * Command Palette (and the default keybindings) are always available to
 * re-zoom in a fresh session.
 */

import { create } from "zustand";

const EDITOR_DELTA_MIN = -8;
const EDITOR_DELTA_MAX = 20;
const UI_LEVEL_MIN = -5;
const UI_LEVEL_MAX = 10;

interface ZoomState {
  editorDelta: number;
  uiLevel: number;
  zoomInEditor: () => void;
  zoomOutEditor: () => void;
  resetEditorZoom: () => void;
  zoomInUi: () => void;
  zoomOutUi: () => void;
  resetUiZoom: () => void;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export const useZoom = create<ZoomState>((set) => ({
  editorDelta: 0,
  uiLevel: 0,
  zoomInEditor: () => set((s) => ({ editorDelta: clamp(s.editorDelta + 1, EDITOR_DELTA_MIN, EDITOR_DELTA_MAX) })),
  zoomOutEditor: () => set((s) => ({ editorDelta: clamp(s.editorDelta - 1, EDITOR_DELTA_MIN, EDITOR_DELTA_MAX) })),
  resetEditorZoom: () => set({ editorDelta: 0 }),
  zoomInUi: () => set((s) => ({ uiLevel: clamp(s.uiLevel + 1, UI_LEVEL_MIN, UI_LEVEL_MAX) })),
  zoomOutUi: () => set((s) => ({ uiLevel: clamp(s.uiLevel - 1, UI_LEVEL_MIN, UI_LEVEL_MAX) })),
  resetUiZoom: () => set({ uiLevel: 0 }),
}));

/** One UI zoom step is +/-10%, e.g. level 3 -> 1.3x, level -2 -> 0.8x. */
export function uiZoomFactor(level: number): number {
  return 1 + level * 0.1;
}
