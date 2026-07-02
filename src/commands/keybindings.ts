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
export function normalizeKey(e: KeyboardEvent): string {
  const k = e.key.toLowerCase();
  // `=`/`-` sometimes arrive as their shifted/unshifted siblings depending on
  // keyboard layout; `e.code` is layout-independent for the top-row keys.
  if (e.code === "Equal" || e.code === "NumpadAdd") return "=";
  if (e.code === "Minus" || e.code === "NumpadSubtract") return "-";
  if (e.code === "Digit0" || e.code === "Numpad0") return "0";
  return k;
}

/** Build a normalized combo from a live keydown, for the keybinding editor's
 *  "record a shortcut" capture (Addendum II §S6). Returns `null` while only a
 *  modifier is held (keep listening) or when Ctrl/Cmd isn't part of the chord —
 *  every rebindable combo requires "mod" so a global capture-phase listener
 *  (Addendum II §S3) can never swallow ordinary typing. */
export function captureCombo(e: KeyboardEvent): string | null {
  const key = normalizeKey(e);
  if (["control", "meta", "shift", "alt", "os", "contextmenu"].includes(key)) return null;
  if (!(e.ctrlKey || e.metaKey)) return null;
  const parts = ["mod"];
  if (e.shiftKey) parts.push("shift");
  if (e.altKey) parts.push("alt");
  parts.push(key);
  return parts.join("+");
}

const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);

/** Human-readable form of a normalized combo, e.g. "mod+shift+p" -> "Ctrl+Shift+P". */
export function formatCombo(combo: string): string {
  return combo
    .split("+")
    .map((part) => {
      if (part === "mod") return isMac ? "Cmd" : "Ctrl";
      if (part === "shift") return "Shift";
      if (part === "alt") return isMac ? "Option" : "Alt";
      return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("+");
}
