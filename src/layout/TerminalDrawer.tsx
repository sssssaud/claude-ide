/*
 * Terminal drawer (spec 5.A.6). A collapsible bottom drawer hosting a real
 * plain shell: xterm.js bridged to a `portable-pty` PTY in Rust. Keystrokes
 * stream out via `pty_write`, raw shell bytes stream back over a channel into
 * `term.write`, and the PTY resizes with the drawer. The shell is kept alive
 * across collapse (just hidden) and killed cleanly on unmount / app exit; a
 * Restart control re-spawns it if it dies or you `exit`. The optional native
 * `claude` passthrough (§2.2) is deferred.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ptyClose, ptyOpen, ptyResize, ptyWrite } from "@/ipc/commands";

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function TerminalDrawer() {
  const [collapsed, setCollapsed] = useState(false);
  const [exited, setExited] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);

  // Spawn a fresh shell into the existing terminal and wire its output back.
  const openShell = useCallback(async () => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    try {
      fit.fit();
    } catch {
      /* container momentarily zero-sized */
    }
    setExited(false);
    try {
      const id = await ptyOpen(
        (bytes) => {
          const t = termRef.current;
          if (!t) return;
          if (bytes.length === 0) {
            // EOF sentinel: the shell exited.
            ptyIdRef.current = null;
            setExited(true);
            try {
              t.write("\r\n\x1b[2m[process exited — press Restart]\x1b[0m\r\n");
            } catch {
              /* terminal already disposed */
            }
            return;
          }
          try {
            t.write(bytes);
          } catch {
            /* terminal already disposed */
          }
        },
        term.rows,
        term.cols,
      );
      ptyIdRef.current = id;
    } catch {
      setExited(true);
      try {
        term.write("\r\n\x1b[31m[failed to start shell]\x1b[0m\r\n");
      } catch {
        /* disposed */
      }
    }
  }, []);

  // Create the terminal once; keep it (and the shell) alive across collapse.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: token("--font-mono") || "monospace",
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000, // bound memory on huge output (spec 5.A.6 edge)
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
    termRef.current = term;
    fitRef.current = fit;
    try {
      fit.fit();
    } catch {
      /* zero-sized */
    }

    // Keystrokes -> PTY (only once a shell is live).
    const dataSub = term.onData((d) => {
      const id = ptyIdRef.current;
      if (id) void ptyWrite(id, d);
    });

    void openShell();

    // Resize the PTY when the host changes size; skip while collapsed (0-height).
    const ro = new ResizeObserver(() => {
      if (!host.clientHeight) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      const id = ptyIdRef.current;
      if (id && term.rows > 0 && term.cols > 0) void ptyResize(id, term.rows, term.cols);
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      dataSub.dispose();
      const id = ptyIdRef.current;
      if (id) void ptyClose(id);
      ptyIdRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [openShell]);

  const restart = useCallback(async () => {
    const id = ptyIdRef.current;
    if (id) {
      await ptyClose(id);
      ptyIdRef.current = null;
    }
    termRef.current?.reset();
    await openShell();
  }, [openShell]);

  return (
    <div className="flex shrink-0 flex-col" style={{ borderTop: "1px solid var(--color-border-subtle)" }}>
      <div
        className="flex shrink-0 items-center justify-between"
        style={{
          height: "var(--space-7)",
          padding: "0 var(--space-3) 0 var(--space-4)",
          background: "var(--color-bg-raised)",
        }}
      >
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          className="flex flex-1 cursor-pointer items-center gap-[var(--space-2)]"
          style={{ background: "transparent", border: "none", ...headerText }}
        >
          <span aria-hidden="true">{collapsed ? "▴" : "▾"}</span>
          <span>TERMINAL</span>
          {exited && <span style={{ color: "var(--color-fg-muted)" }}>· exited</span>}
        </button>
        <button
          type="button"
          onClick={() => void restart()}
          title="Restart shell"
          aria-label="Restart shell"
          className="cursor-pointer"
          style={{ background: "transparent", border: "none", ...headerText }}
        >
          ↻ restart
        </button>
      </div>
      {/* Host stays mounted (shell survives collapse); height collapses to 0. */}
      <div
        ref={hostRef}
        style={{
          height: collapsed ? 0 : "180px",
          overflow: "hidden",
          background: "var(--color-bg-recessed)",
          padding: collapsed ? 0 : "var(--space-3)",
        }}
      />
    </div>
  );
}

const headerText = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--color-fg-secondary)",
} as const;
