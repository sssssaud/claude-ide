/*
 * Terminal drawer (spec 5.A.6). A collapsible bottom drawer hosting a real
 * plain shell: xterm.js bridged to a `portable-pty` PTY in Rust. Keystrokes
 * stream out via `pty_write`, raw shell bytes stream back over a channel into
 * `term.write`, and the PTY resizes with the drawer. The shell is kept alive
 * across collapse (just hidden) and killed cleanly on unmount / app exit; a
 * Restart control re-spawns it if it dies or you `exit`. The optional native
 * `claude` passthrough (§2.2) is deferred.
 */

import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ptyClose, ptyOpen, ptyResize, ptyWrite } from "@/ipc/commands";
import { useLayout } from "@/store/layout";

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const TERM_HEIGHT_KEY = "ide:term-h";
const MIN_TERM_HEIGHT = 100;

export function TerminalDrawer() {
  // Visibility lives in the layout store so the top-bar toggle and Ctrl/Cmd+J
  // can dock the drawer too; hiding keeps the shell alive (host stays mounted at
  // height 0) so reopening is instant and never restarts the process.
  const visible = useLayout((s) => s.terminal);
  const toggleTerminal = useLayout((s) => s.toggle);
  const [exited, setExited] = useState(false);
  // Drag-resizable body height (the xterm area); the header stays fixed. The
  // ResizeObserver below refits xterm whenever this changes. Persisted so the
  // chosen height survives reloads, like VS Code's panel.
  const [bodyHeight, setBodyHeight] = useState<number>(() => {
    const saved = Number(localStorage.getItem(TERM_HEIGHT_KEY));
    return Number.isFinite(saved) && saved >= MIN_TERM_HEIGHT ? saved : 180;
  });
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const latestHeightRef = useRef(bodyHeight);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  // Bumped on every open / restart / unmount. A `ptyOpen` that resolves after
  // its epoch is stale belongs to a superseded shell — close it, don't leak it
  // (StrictMode remount and unmount-before-open both hit this race).
  const epochRef = useRef(0);

  // Spawn a fresh shell into the existing terminal and wire its output back.
  const openShell = useCallback(async () => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    const myEpoch = ++epochRef.current; // claim this open; supersedes any older
    try {
      fit.fit();
    } catch {
      /* container momentarily zero-sized */
    }
    setExited(false);
    try {
      const id = await ptyOpen(
        (bytes) => {
          if (epochRef.current !== myEpoch) return; // superseded shell; ignore
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
      if (epochRef.current !== myEpoch) {
        // Unmounted or restarted while `ptyOpen` was in flight: don't leak it.
        void ptyClose(id);
        return;
      }
      ptyIdRef.current = id;
    } catch {
      if (epochRef.current !== myEpoch) return;
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
      fontSize: 14,
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
      epochRef.current++; // invalidate any in-flight open so it can't leak
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

  // Drag the top edge to resize the drawer. Pointer capture keeps the drag on
  // the handle (so it never selects terminal text), and the new height is
  // clamped to [MIN, 60% of window] and persisted on release.
  const onResizeDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, startH: latestHeightRef.current };
  }, []);

  const onResizeMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const max = Math.max(MIN_TERM_HEIGHT, Math.round(window.innerHeight * 0.6));
    const next = Math.min(max, Math.max(MIN_TERM_HEIGHT, drag.startH + (drag.startY - e.clientY)));
    latestHeightRef.current = next;
    setBodyHeight(next);
  }, []);

  const onResizeUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    localStorage.setItem(TERM_HEIGHT_KEY, String(latestHeightRef.current));
  }, []);

  return (
    <div className="flex shrink-0 flex-col">
      {/* Header + drag handle render only while shown; the host stays mounted
          (height 0 when hidden) so the shell survives a dock/undock. */}
      {visible && (
        <>
          {/* Drag handle on the drawer's top edge; also serves as the divider line. */}
          <div
            className="resize-sep"
            data-axis="y"
            onPointerDown={onResizeDown}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeUp}
            style={{
              position: "relative",
              flexShrink: 0,
              height: "1px",
              background: "var(--color-border-subtle)",
              cursor: "row-resize",
              touchAction: "none",
            }}
          />
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
              onClick={() => toggleTerminal("terminal")}
              aria-expanded={true}
              aria-label="Hide terminal"
              title="Hide terminal (Ctrl+J)"
              className="flex flex-1 cursor-pointer items-center gap-[var(--space-2)]"
              style={{ background: "transparent", border: "none", ...headerText }}
            >
              <span aria-hidden="true">▾</span>
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
        </>
      )}
      <div
        ref={hostRef}
        style={{
          height: visible ? bodyHeight : 0,
          overflow: "hidden",
          background: "var(--color-bg-recessed)",
          padding: visible ? "var(--space-3)" : 0,
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
