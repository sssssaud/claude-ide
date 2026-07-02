/*
 * Keyboard-shortcut cheat sheet (Addendum II §S7). A reference overlay — every
 * command grouped by category with its effective shortcut, unlike the Command
 * Palette (search-and-run, hides disabled commands, no grouping). Opens via
 * "Ctrl+K Ctrl+S" (the registry's chord command, `help.cheatSheet`) or a bare
 * "?", which this component listens for itself since a global dispatcher combo
 * without "mod" would collide with ordinary typing — guarded by
 * `isTypingContext` so pressing "?" in a search box or the prompt bar just
 * types a question mark.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { COMMANDS, type Command } from "@/commands/registry";
import { formatCombo, isTypingContext } from "@/commands/keybindings";
import { effectiveCombo } from "@/store/keybindings";
import { useOverlays } from "@/store/overlays";

function shortcutLabel(cmd: Command): string {
  if (cmd.combo) {
    const combo = effectiveCombo(cmd.id, cmd.combo);
    if (combo) return formatCombo(combo);
  }
  return cmd.keybinding ?? "";
}

export function CheatSheet() {
  const open = useOverlays((s) => s.cheatSheet);
  const close = useOverlays((s) => s.closeCheatSheet);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // The dedicated "?" hotkey — the registry's chord ("Ctrl+K Ctrl+S") already
  // goes through the normal dispatcher; this is the one bare-key exception.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingContext()) return;
      e.preventDefault();
      useOverlays.getState().openCheatSheet();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, close]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byCategory = new Map<string, Command[]>();
    for (const cmd of COMMANDS) {
      if (q && !cmd.title.toLowerCase().includes(q) && !cmd.category.toLowerCase().includes(q)) continue;
      const list = byCategory.get(cmd.category) ?? [];
      list.push(cmd);
      byCategory.set(cmd.category, list);
    }
    return [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [query]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      className="fixed inset-0 flex items-start justify-center"
      style={{ background: "rgba(0,0,0,0.45)", zIndex: 40, paddingTop: "10vh" }}
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(640px, 92%)",
          maxHeight: "76vh",
          display: "flex",
          flexDirection: "column",
          borderRadius: "var(--radius-lg)",
          background: "var(--color-bg-overlay)",
          boxShadow: "var(--elev-3)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "var(--space-4) var(--space-5)", borderBottom: "1px solid var(--color-border-subtle)" }}>
          <div className="flex items-center justify-between">
            <p style={{ color: "var(--color-fg-primary)", fontSize: "var(--text-md)", fontWeight: 600 }}>Keyboard Shortcuts</p>
            <span style={{ color: "var(--color-fg-muted)", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}>Esc to close</span>
          </div>
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter shortcuts"
            className="w-full"
            style={{
              marginTop: "var(--space-3)",
              height: "var(--space-7)",
              padding: "0 var(--space-3)",
              border: "1px solid var(--color-border-strong)",
              borderRadius: "var(--radius-md)",
              background: "var(--color-bg-base)",
              color: "var(--color-fg-primary)",
              fontFamily: "var(--font-sans)",
              fontSize: "var(--text-sm)",
            }}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-auto" style={{ padding: "var(--space-3) var(--space-5)" }}>
          {groups.length === 0 ? (
            <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-sm)", padding: "var(--space-4) 0" }}>
              No matching commands.
            </p>
          ) : (
            groups.map(([category, cmds]) => (
              <div key={category} style={{ marginBottom: "var(--space-4)" }}>
                <h2 style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "var(--space-2)" }}>
                  {category}
                </h2>
                {cmds.map((cmd) => {
                  const shortcut = shortcutLabel(cmd);
                  return (
                    <div
                      key={cmd.id}
                      className="flex items-center justify-between gap-[var(--space-4)]"
                      style={{ padding: "var(--space-2) var(--space-2)", borderRadius: "var(--radius-sm)" }}
                    >
                      <span style={{ color: "var(--color-fg-primary)", fontSize: "var(--text-sm)" }}>{cmd.title}</span>
                      {shortcut && (
                        <span style={{ color: "var(--color-fg-secondary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", whiteSpace: "nowrap" }}>
                          {shortcut}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
