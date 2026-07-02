/*
 * Global keybinding dispatcher (Phase 5; Addendum II §S3, S6). Live anywhere in
 * the app — bound in the capture phase so shortcuts fire even when focus is in
 * Monaco or the terminal. Driven entirely by the command registry
 * (`commands/registry.ts`): every command's *effective* combo — a user override
 * (`store/keybindings.ts`) if one is set, else its built-in default — is matched
 * here and, if enabled, run; `preventDefault` only for a matched, enabled combo,
 * so every other keystroke (including the editor's own bindings, like Monaco's
 * own Ctrl+S/Ctrl+G) is left completely untouched.
 */

import { useEffect } from "react";
import { COMMANDS } from "@/commands/registry";
import { matchesCombo } from "@/commands/keybindings";
import { effectiveCombo, useKeybindings } from "@/store/keybindings";

export function useLayoutShortcuts() {
  useEffect(() => {
    if (!useKeybindings.getState().loaded) void useKeybindings.getState().load();
    const onKeyDown = (e: KeyboardEvent) => {
      for (const cmd of COMMANDS) {
        const combo = effectiveCombo(cmd.id, cmd.combo);
        if (!combo || !matchesCombo(e, combo)) continue;
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
