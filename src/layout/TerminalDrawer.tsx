/*
 * Terminal drawer (spec 5.A.6). Phase 0 proves xterm.js mounts, themes from
 * tokens, fits its container, and disposes cleanly. The PTY-backed plain shell
 * (portable-pty, ≤16ms echo, killed on close) lands in Phase 2; the optional
 * unmanaged `claude` passthrough is deferred (spec 2.2).
 */

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function TerminalDrawer() {
  const [collapsed, setCollapsed] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (collapsed || !hostRef.current) return;
    const host = hostRef.current;

    const term = new Terminal({
      fontFamily: token("--font-mono") || "monospace",
      fontSize: 12,
      cursorBlink: true,
      theme: {
        background: token("--color-bg-recessed"),
        foreground: token("--color-fg-primary"),
        cursor: token("--color-accent"),
        selectionBackground: token("--color-accent-quiet"),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    term.writeln("\x1b[2mClaude IDE — terminal drawer\x1b[0m");
    term.writeln("Plain-shell wiring (portable-pty) lands in Phase 2.");

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* container momentarily zero-sized during layout */
      }
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      term.dispose();
    };
  }, [collapsed]);

  return (
    <div className="flex flex-col" style={{ borderTop: "1px solid var(--color-border-subtle)" }}>
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex shrink-0 cursor-pointer items-center justify-between"
        aria-expanded={!collapsed}
        style={{
          height: "var(--space-7)",
          padding: "0 var(--space-4)",
          background: "var(--color-bg-raised)",
          border: "none",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color: "var(--color-fg-secondary)",
        }}
      >
        <span>TERMINAL</span>
        <span aria-hidden="true">{collapsed ? "▴" : "▾"}</span>
      </button>
      {!collapsed && (
        <div
          ref={hostRef}
          style={{
            height: "180px",
            background: "var(--color-bg-recessed)",
            padding: "var(--space-3)",
          }}
        />
      )}
    </div>
  );
}
