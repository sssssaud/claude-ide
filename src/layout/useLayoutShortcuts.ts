/*
 * Global keybinding dispatcher (Phase 5; Addendum II §S3, S6, S7). Live
 * anywhere in the app — bound in the capture phase so shortcuts fire even
 * when focus is in Monaco or the terminal. Driven entirely by the command
 * registry (`commands/registry.ts`): every command's *effective* combo — a
 * user override (`store/keybindings.ts`) if one is set, else its built-in
 * default — is matched here and, if enabled, run; `preventDefault` only for a
 * matched, enabled combo, so every other keystroke (including the editor's
 * own bindings, like Monaco's own Ctrl+S/Ctrl+G) is left completely untouched.
 *
 * A combo may be a two-step CHORD, comma-joined ("mod+k,mod+s" = Ctrl+K then
 * Ctrl+S — the same syntax `settings.rs` already validates for keybinding
 * overrides). The first step that matches any chord's opening key arms a
 * short-lived "awaiting second key" state; if the next keydown completes a
 * chord it runs, otherwise the state clears and that keydown is re-evaluated
 * fresh (so a broken chord attempt can still trigger an unrelated shortcut).
 */

import { useEffect } from "react";
import { COMMANDS } from "@/commands/registry";
import { matchesCombo } from "@/commands/keybindings";
import { effectiveCombo, useKeybindings } from "@/store/keybindings";

/** How long the second chord key has to arrive (VS Code uses a similar window). */
const CHORD_TIMEOUT_MS = 1500;

/** Try every command's single-step combo against `e`; run + consume the first
 *  enabled match. Returns whether one fired. */
function tryRunSingleStep(e: KeyboardEvent): boolean {
  for (const cmd of COMMANDS) {
    const combo = effectiveCombo(cmd.id, cmd.combo);
    if (!combo || combo.includes(",")) continue;
    if (!matchesCombo(e, combo)) continue;
    if (cmd.enabled && !cmd.enabled()) continue;
    e.preventDefault();
    void cmd.run();
    return true;
  }
  return false;
}

/** Does `e` open any chord's first step? If so, consume it and return the
 *  matched first-step string to arm the "awaiting second key" state. */
function tryArmChord(e: KeyboardEvent): string | null {
  for (const cmd of COMMANDS) {
    const combo = effectiveCombo(cmd.id, cmd.combo);
    if (!combo) continue;
    const steps = combo.split(",");
    if (steps.length !== 2) continue;
    if (!matchesCombo(e, steps[0])) continue;
    e.preventDefault();
    return steps[0];
  }
  return null;
}

/** With a chord armed on `firstStep`, does `e` complete it? Runs + consumes
 *  the first enabled match. Returns whether one fired. */
function tryCompleteChord(e: KeyboardEvent, firstStep: string): boolean {
  for (const cmd of COMMANDS) {
    const combo = effectiveCombo(cmd.id, cmd.combo);
    if (!combo) continue;
    const steps = combo.split(",");
    if (steps.length !== 2 || steps[0] !== firstStep) continue;
    if (!matchesCombo(e, steps[1])) continue;
    if (cmd.enabled && !cmd.enabled()) continue;
    e.preventDefault();
    void cmd.run();
    return true;
  }
  return false;
}

export function useLayoutShortcuts() {
  useEffect(() => {
    if (!useKeybindings.getState().loaded) void useKeybindings.getState().load();

    let pendingFirstStep: string | null = null;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    const clearPending = () => {
      pendingFirstStep = null;
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (pendingFirstStep) {
        const firstStep = pendingFirstStep;
        clearPending();
        if (tryCompleteChord(e, firstStep)) return;
        // Second key didn't complete the chord — fall through and evaluate
        // this keydown fresh, exactly as if no chord had been armed.
      }
      if (tryRunSingleStep(e)) return;
      const armed = tryArmChord(e);
      if (armed) {
        pendingFirstStep = armed;
        pendingTimer = setTimeout(clearPending, CHORD_TIMEOUT_MS);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      clearPending();
    };
  }, []);
}
