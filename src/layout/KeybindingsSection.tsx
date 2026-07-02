/*
 * Keybinding editor (Addendum II §S6) — a searchable list of every rebindable
 * command, each showing its effective combo (override or default), a "Change"
 * capture control, and a reset. Saves are immediate (`store/keybindings.ts`),
 * not staged — there's nothing to Apply here. "Change" listens for the next
 * keydown that includes Ctrl/Cmd (so a global capture-phase rebind can never
 * swallow ordinary typing) and warns, without blocking, if it collides with
 * another command's effective combo.
 */

import { useEffect, useRef, useState } from "react";
import { EmptyState } from "@/components/states";
import { captureCombo, formatCombo } from "@/commands/keybindings";
import { COMMANDS, type Command } from "@/commands/registry";
import { effectiveCombo, useKeybindings } from "@/store/keybindings";

// Owned by Monaco's own per-instance keybinding, deliberately not duplicated at
// the window level (see `commands/registry.ts`) — excluded from rebinding.
const NOT_REBINDABLE = new Set(["file.save", "editor.gotoLine"]);

export function KeybindingsSection() {
  const overrides = useKeybindings((s) => s.overrides);
  const loaded = useKeybindings((s) => s.loaded);
  const loadError = useKeybindings((s) => s.loadError);
  const saveError = useKeybindings((s) => s.saveError);
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<string | null>(null);
  const [pending, setPending] = useState<{ commandId: string; combo: string; conflictTitle: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!loaded) void useKeybindings.getState().load();
  }, [loaded]);

  const bindable = COMMANDS.filter((c) => !NOT_REBINDABLE.has(c.id));
  const q = query.trim().toLowerCase();
  const visible = bindable.filter(
    (c) => !q || c.title.toLowerCase().includes(q) || c.category.toLowerCase().includes(q),
  );

  const findConflict = (commandId: string, combo: string): Command | undefined =>
    bindable.find((c) => c.id !== commandId && effectiveCombo(c.id, c.combo) === combo);

  // Capture the next qualifying keydown while `recording` names a command.
  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setRecording(null);
        return;
      }
      const combo = captureCombo(e);
      if (!combo) {
        // Modifier-only, or missing Ctrl/Cmd — keep listening, but still eat
        // the keystroke so it doesn't leak into whatever's behind the dialog.
        e.preventDefault();
        return;
      }
      e.preventDefault();
      setRecording(null);
      const conflict = findConflict(recording, combo);
      if (conflict) {
        setPending({ commandId: recording, combo, conflictTitle: conflict.title });
      } else {
        void useKeybindings.getState().setOverride(recording, combo);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recording]);

  return (
    <div className="flex flex-col" style={{ gap: "var(--space-3)" }}>
      <label className="flex items-center">
        <span className="sr-only">Search keybindings</span>
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search commands"
          className="w-full"
          style={{
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
      </label>

      {loadError && (
        <p role="alert" style={{ color: "var(--color-status-danger)", fontSize: "var(--text-xs)" }}>
          Couldn't load keybindings: {loadError}
        </p>
      )}
      {saveError && (
        <p role="alert" style={{ color: "var(--color-status-danger)", fontSize: "var(--text-xs)" }}>
          {saveError}
        </p>
      )}

      {loaded && visible.length === 0 ? (
        <EmptyState title="No matching commands" hint={`Nothing matches “${query.trim()}”.`} />
      ) : (
        <div className="flex flex-col">
          {visible.map((cmd) => {
            const combo = effectiveCombo(cmd.id, cmd.combo);
            const isOverridden = overrides[cmd.id] !== undefined && overrides[cmd.id] !== "";
            return (
              <div
                key={cmd.id}
                className="flex items-center justify-between gap-[var(--space-5)] transition-colors hover:bg-[var(--color-bg-raised)]"
                style={{
                  padding: "var(--space-3) var(--space-3)",
                  borderBottom: "1px solid var(--color-border-subtle)",
                  borderRadius: "var(--radius-sm)",
                  transitionDuration: "var(--motion-fast)",
                }}
              >
                <div className="min-w-0">
                  <p style={{ color: "var(--color-fg-primary)", fontSize: "var(--text-sm)" }}>{cmd.title}</p>
                  <p style={{ color: "var(--color-fg-muted)", fontSize: "var(--text-xs)", marginTop: "2px" }}>{cmd.category}</p>
                </div>
                <div className="flex shrink-0 items-center gap-[var(--space-3)]">
                  <span
                    style={{
                      minWidth: "120px",
                      textAlign: "right",
                      color: combo ? "var(--color-fg-secondary)" : "var(--color-fg-muted)",
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--text-xs)",
                    }}
                  >
                    {combo ? formatCombo(combo) : "Unbound"}
                  </span>
                  {isOverridden && (
                    <button
                      type="button"
                      onClick={() => void useKeybindings.getState().resetOverride(cmd.id)}
                      className="cursor-pointer"
                      style={{ border: "none", background: "transparent", padding: 0, color: "var(--color-accent)", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}
                    >
                      Reset
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setRecording(cmd.id)}
                    aria-pressed={recording === cmd.id}
                    className="cursor-pointer"
                    style={{
                      padding: "var(--space-1) var(--space-3)",
                      border: `1px solid ${recording === cmd.id ? "var(--color-accent)" : "var(--color-border-strong)"}`,
                      borderRadius: "var(--radius-sm)",
                      background: recording === cmd.id ? "var(--color-accent-quiet)" : "transparent",
                      color: "var(--color-fg-primary)",
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--text-xs)",
                    }}
                  >
                    {recording === cmd.id ? "Press a shortcut…" : "Change"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {pending && (
        <div className="absolute inset-0 flex items-center justify-center" role="alertdialog" aria-modal="true" aria-label="Keybinding conflict" style={{ background: "rgba(0,0,0,0.45)", zIndex: 20 }}>
          <div style={{ width: "min(440px, 90%)", padding: "var(--space-6)", borderRadius: "var(--radius-lg)", background: "var(--color-bg-overlay)", boxShadow: "var(--elev-3)" }}>
            <p style={{ color: "var(--color-fg-primary)", fontSize: "var(--text-md)", fontWeight: 600 }}>Already in use</p>
            <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-sm)", marginTop: "var(--space-3)" }}>
              <strong>{formatCombo(pending.combo)}</strong> is already bound to “{pending.conflictTitle}”. Both commands would
              fire on this key — the one higher in this list wins.
            </p>
            <div className="flex justify-end gap-[var(--space-3)]" style={{ marginTop: "var(--space-5)" }}>
              <button
                type="button"
                onClick={() => setPending(null)}
                className="cursor-pointer"
                style={{ padding: "var(--space-2) var(--space-5)", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border-strong)", background: "transparent", color: "var(--color-fg-primary)", fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)" }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void useKeybindings.getState().setOverride(pending.commandId, pending.combo);
                  setPending(null);
                }}
                className="cursor-pointer"
                style={{ padding: "var(--space-2) var(--space-5)", borderRadius: "var(--radius-md)", border: "1px solid var(--color-accent)", background: "var(--color-accent)", color: "var(--color-bg-base)", fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)", fontWeight: 500 }}
              >
                Set anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
