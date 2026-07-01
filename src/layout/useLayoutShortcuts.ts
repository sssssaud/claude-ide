/*
 * Global keybinding dispatcher (Phase 5; Addendum II §S3). Live anywhere in the
 * app — bound in the capture phase so shortcuts fire even when focus is in
 * Monaco or the terminal. Driven entirely by the command registry
 * (`commands/registry.ts`): every command with a `combo` is matched here and,
 * if enabled, run; `preventDefault` only for a matched, enabled combo, so every
 * other keystroke (including the editor's own bindings, like Monaco's own
 * Ctrl+S/Ctrl+G) is left completely untouched.
 */

import { useEffect } from "react";
import { COMMANDS } from "@/commands/registry";
import { matchesCombo } from "@/commands/keybindings";

export function useLayoutShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      for (const cmd of COMMANDS) {
        if (!cmd.combo || !matchesCombo(e, cmd.combo)) continue;
        if (cmd.enabled && !cmd.enabled()) continue;
        e.preventDefault();
        void cmd.run();
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
