/*
 * Command Palette (Addendum II §S3, §2.3): Ctrl/Cmd+Shift+P, fuzzy over every
 * registered command, shows its keybinding per row (§2.3's explicit ask).
 * Thin wrapper over `FuzzyOverlay` — all it adds is the command list + row.
 */

import { COMMANDS, availableCommands, type Command } from "@/commands/registry";
import { FuzzyOverlay } from "@/layout/FuzzyOverlay";
import { useOverlays } from "@/store/overlays";

export function CommandPalette() {
  const open = useOverlays((s) => s.palette);
  const close = useOverlays((s) => s.closePalette);

  return (
    <FuzzyOverlay<Command>
      open={open}
      onClose={close}
      placeholder="Type a command…"
      ariaLabel="Command Palette"
      emptyLabel="No matching commands."
      items={open ? availableCommands() : COMMANDS}
      itemKey={(c) => c.id}
      itemText={(c) => `${c.category}: ${c.title}`}
      onSelect={(c) => void c.run()}
      renderItem={(c) => (
        <div className="flex items-center justify-between gap-[var(--space-4)]" style={{ padding: "var(--space-3) var(--space-3)" }}>
          <span style={{ color: "var(--color-fg-primary)", fontSize: "var(--text-sm)" }}>
            <span style={{ color: "var(--color-fg-muted)" }}>{c.category}: </span>
            {c.title}
          </span>
          {c.keybinding && (
            <span
              style={{
                flexShrink: 0,
                color: "var(--color-fg-muted)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
              }}
            >
              {c.keybinding}
            </span>
          )}
        </div>
      )}
    />
  );
}
