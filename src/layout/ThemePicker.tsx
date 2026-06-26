/*
 * Theme picker (Phase 10). A compact dropdown in the top bar that lets the
 * developer switch the app palette — Dark (default), Midnight, Light, or System
 * (follow the OS). It's a native <select> on purpose: fully keyboard-accessible
 * and screen-reader-labelled for free, and it stays out of the way until used.
 * The selection persists and re-themes the whole app instantly (see
 * `store/theme.ts`); no reload, no component changes — only the tokens flip.
 */

import { THEME_OPTIONS, useTheme, type ThemeChoice } from "@/store/theme";

export function ThemePicker() {
  const choice = useTheme((s) => s.choice);
  const setChoice = useTheme((s) => s.setChoice);

  return (
    <label className="flex items-center" title="Theme">
      <span className="sr-only">Theme</span>
      <select
        value={choice}
        onChange={(e) => setChoice(e.target.value as ThemeChoice)}
        aria-label="Theme"
        className="cursor-pointer"
        style={{
          height: "var(--space-6)",
          padding: "0 var(--space-2)",
          border: "1px solid var(--color-border-subtle)",
          borderRadius: "var(--radius-sm)",
          background: "var(--color-bg-raised)",
          color: "var(--color-fg-secondary)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          lineHeight: 1,
        }}
      >
        {THEME_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}
