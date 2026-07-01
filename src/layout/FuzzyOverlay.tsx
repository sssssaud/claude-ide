/*
 * Shared shell for the two global fuzzy overlays (Addendum II §S3): the
 * Command Palette and Quick Open. A fixed backdrop, a top-anchored input +
 * ranked list, Up/Down/Enter/Escape — the part that's identical between them;
 * each caller only supplies its items, how to render a row, and what "select"
 * does.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { fuzzyFilter } from "@/commands/fuzzy";

export function FuzzyOverlay<T>({
  open,
  onClose,
  placeholder,
  items,
  itemKey,
  itemText,
  renderItem,
  onSelect,
  emptyLabel,
  ariaLabel,
}: {
  open: boolean;
  onClose: () => void;
  placeholder: string;
  items: T[];
  itemKey: (item: T) => string;
  itemText: (item: T) => string;
  renderItem: (item: T, active: boolean) => ReactNode;
  onSelect: (item: T) => void;
  emptyLabel: string;
  ariaLabel: string;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = fuzzyFilter(items, query, itemText);

  // Reset to a clean slate every time the overlay opens, and focus the input.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    // Let the input mount before focusing.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Keep the selection in range as the filtered list shrinks (e.g. backspacing
  // after a narrow query widens it, or a keystroke narrows it under `selected`).
  useEffect(() => {
    setSelected((i) => Math.min(i, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  if (!open) return null;

  const commit = (item: T | undefined) => {
    if (!item) return;
    onSelect(item);
    onClose();
  };

  return (
    <div className="fixed inset-0" style={{ zIndex: 100 }}>
      <div
        onClick={onClose}
        className="fixed inset-0"
        aria-hidden="true"
        style={{ background: "rgba(0, 0, 0, 0.45)" }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className="absolute left-1/2"
        style={{
          top: "12vh",
          transform: "translateX(-50%)",
          width: "min(560px, 90vw)",
          maxHeight: "60vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--color-bg-overlay)",
          border: "1px solid var(--color-border-strong)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--elev-3)",
          overflow: "hidden",
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelected((i) => Math.min(filtered.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelected((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            commit(filtered[selected]);
          }
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="w-full"
          style={{
            padding: "var(--space-4)",
            border: "none",
            borderBottom: "1px solid var(--color-border-subtle)",
            background: "transparent",
            color: "var(--color-fg-primary)",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-md)",
          }}
        />
        <div role="listbox" aria-label={ariaLabel} className="min-h-0 flex-1 overflow-y-auto" style={{ padding: "var(--space-2)" }}>
          {filtered.length === 0 ? (
            <p style={{ padding: "var(--space-4)", color: "var(--color-fg-muted)", fontSize: "var(--text-sm)" }}>
              {emptyLabel}
            </p>
          ) : (
            filtered.map((item, i) => (
              <div
                key={itemKey(item)}
                role="option"
                aria-selected={i === selected}
                onMouseEnter={() => setSelected(i)}
                onClick={() => commit(item)}
                className="cursor-pointer"
                style={{
                  borderRadius: "var(--radius-sm)",
                  background: i === selected ? "var(--color-accent-quiet)" : "transparent",
                }}
              >
                {renderItem(item, i === selected)}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
