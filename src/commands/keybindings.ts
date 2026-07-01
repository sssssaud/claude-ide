/*
 * Matches a `KeyboardEvent` against a command's normalized `combo` string
 * (Addendum II §S3). "mod" means Ctrl on Windows/Linux, Cmd on macOS — the one
 * platform difference; everything else (b, shift+p, =, -, 0, ,) matches the
 * literal key. No chord/sequence support (e.g. "Ctrl+K Ctrl+S") — every
 * registered combo today is a single keystroke.
 */

export function matchesCombo(e: KeyboardEvent, combo: string): boolean {
  const parts = combo.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  const wantShift = parts.includes("shift");
  const wantAlt = parts.includes("alt");
  const wantMod = parts.includes("mod");

  const hasMod = e.ctrlKey || e.metaKey;
  if (wantMod !== hasMod) return false;
  if (wantShift !== e.shiftKey) return false;
  if (wantAlt !== e.altKey) return false;

  return normalizeKey(e) === key;
}

/** The event's own key, normalized to match how combos are written above. */
function normalizeKey(e: KeyboardEvent): string {
  const k = e.key.toLowerCase();
  // `=`/`-` sometimes arrive as their shifted/unshifted siblings depending on
  // keyboard layout; `e.code` is layout-independent for the top-row keys.
  if (e.code === "Equal" || e.code === "NumpadAdd") return "=";
  if (e.code === "Minus" || e.code === "NumpadSubtract") return "-";
  if (e.code === "Digit0" || e.code === "Numpad0") return "0";
  return k;
}
