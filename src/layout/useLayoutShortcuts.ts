/*
 * Global layout shortcuts (Phase 5). VS Code-style panel toggles, live anywhere
 * in the app: Ctrl/Cmd+B toggles the Sessions rail, Ctrl/Cmd+J toggles the
 * Terminal drawer. Bound in the capture phase so they fire even when focus is in
 * Monaco or the terminal, and `preventDefault` only for our two combos — every
 * other keystroke (including the editor's own bindings) is left untouched.
 */

import { useEffect } from "react";
import { useLayout } from "@/store/layout";

export function useLayoutShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Require exactly Ctrl/Cmd (no Shift/Alt) so we don't shadow richer combos.
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "b") {
        e.preventDefault();
        useLayout.getState().toggle("sessions");
      } else if (key === "j") {
        e.preventDefault();
        useLayout.getState().toggle("terminal");
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
