/*
 * Global layout shortcuts (Phase 5; Addendum II). VS Code-style, live anywhere in
 * the app: Ctrl/Cmd+B toggles the Side panel, Ctrl/Cmd+J toggles the Terminal
 * drawer, Ctrl/Cmd+, opens Settings (as an editor tab). Bound in the capture
 * phase so they fire even when focus is in Monaco or the terminal, and
 * `preventDefault` only for our combos — every other keystroke (including the
 * editor's own bindings) is left untouched.
 */

import { useEffect } from "react";
import { activeEditorStore } from "@/store/editor";
import { useLayout } from "@/store/layout";

export function useLayoutShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Require exactly Ctrl/Cmd (no Shift/Alt) so we don't shadow richer combos.
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "b") {
        e.preventDefault();
        useLayout.getState().toggle("sidebar");
      } else if (key === "j") {
        e.preventDefault();
        useLayout.getState().toggle("terminal");
      } else if (key === ",") {
        e.preventDefault();
        useLayout.getState().setVisible("editor", true);
        activeEditorStore().getState().openSettings();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
