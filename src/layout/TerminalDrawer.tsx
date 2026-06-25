/*
 * Terminal drawer (spec 5.A.6). A collapsible bottom drawer hosting a real
 * plain shell: xterm.js bridged to a `portable-pty` PTY in Rust. Keystrokes
 * stream out via `pty_write`, raw shell bytes stream back over a channel into
 * `term.write`, and the PTY resizes with the drawer. The shell is kept alive
 * across collapse (just hidden) and killed cleanly on unmount / app exit; a
 * Restart control re-spawns it if it dies or you `exit`. The optional native
 * `claude` passthrough (§2.2) is deferred.
 *
 * Phase 5 (B6): terminals are PER-WORKSPACE. Each workspace gets its own
 * xterm + PTY rooted in that workspace's cwd; the active one is shown and the
 * others stay mounted (shell alive, just `visibility:hidden`) so switching is
 * instant and never restarts a shell. The shell spawns lazily the first time a
 * workspace is focused, then is kept alive. Shared chrome (drag-resize, label,
 * hide toggle) lives in the parent; restart / exited act on the active terminal.
 */

import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ptyClose, ptyOpen, ptyResize, ptyWrite } from "@/ipc/commands";
import { useLayout } from "@/store/layout";
import { useWorkspaces } from "@/store/workspaces";

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const TERM_HEIGHT_KEY = "ide:term-h";
const MIN_TERM_HEIGHT = 100;

export function TerminalDrawer() {
  // Visibility lives in the layout store so the top-bar toggle and Ctrl/Cmd+J
  // can dock the drawer too; hiding keeps every shell alive (hosts stay mounted)
  // so reopening is instant and never restarts a process.
  const visible = useLayout((s) => s.terminal);
  const toggleTerminal = useLayout((s) => s.toggle);
  const workspaces = useWorkspaces((s) => s.workspaces);
  const activeId = useWorkspaces((s) => s.activeId);

  // The active terminal's exited state + restart fn, registered by the children
  // so the shared header can drive whichever terminal is in front.
  const [exitedMap, setExitedMap] = useState<Record<string, boolean>>({});
  const restartFns = useRef<Map<string, () => Promise<void>>>(new Map());

  const reportExited = useCallback((cwd: string, ex: boolean) => {
    setExitedMap((m) => (m[cwd] === ex ? m : { ...m, [cwd]: ex }));
  }, []);
  const registerRestart = useCallback(
    (cwd: string, fn: (() => Promise<void>) | null) => {
      if (fn) restartFns.current.set(cwd, fn);
      else restartFns.current.delete(cwd);
    },
    [],
  );

  const activeExited = activeId ? !!exitedMap[activeId] : false;
  const restartActive = useCallback(() => {
    if (activeId) void restartFns.current.get(activeId)?.();
  }, [activeId]);

  // Drag-resizable body height (the xterm area); the header stays fixed. Each
  // terminal's ResizeObserver refits when this changes. Persisted so the chosen
  // height survives reloads, like VS Code's panel.
  const [bodyHeight, setBodyHeight] = useState<number>(() => {
    const saved = Number(localStorage.getItem(TERM_HEIGHT_KEY));
    return Number.isFinite(saved) && saved >= MIN_TERM_HEIGHT ? saved : 180;
  });
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const latestHeightRef = useRef(bodyHeight);

  // Drag the top edge to resize the drawer. Pointer capture keeps the drag on
  // the handle (so it never selects terminal text); the new height is clamped to
  // [MIN, 60% of window] and persisted on release.
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
      {/* Header + drag handle render only while shown; the hosts stay mounted
          (body height 0 when hidden) so the shells survive a dock/undock. */}
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
              {activeExited && <span style={{ color: "var(--color-fg-muted)" }}>· exited</span>}
            </button>
            <button
              type="button"
              onClick={restartActive}
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
        style={{
          position: "relative",
          height: visible ? bodyHeight : 0,
          overflow: "hidden",
          background: "var(--color-bg-recessed)",
        }}
      >
        {/* One kept-alive terminal per workspace; only the active is visible. */}
        {workspaces.map((w) => (
          <WorkspaceTerminal
            key={w.id}
            cwd={w.id}
            active={w.id === activeId}
            visible={visible}
            reportExited={reportExited}
            registerRestart={registerRestart}
          />
        ))}
      </div>
    </div>
  );
}

/** One workspace's terminal: its own xterm + PTY rooted in `cwd`. Stays mounted
 *  (shell alive, `visibility:hidden`) when another workspace is active, so
 *  switching back is instant. The shell spawns lazily on first focus. */
function WorkspaceTerminal({
  cwd,
  active,
  visible,
  reportExited,
  registerRestart,
}: {
  cwd: string;
  active: boolean;
  visible: boolean;
  reportExited: (cwd: string, exited: boolean) => void;
  registerRestart: (cwd: string, fn: (() => Promise<void>) | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  // Bumped on every open / restart / unmount. A `ptyOpen` that resolves after
  // its epoch is stale belongs to a superseded shell — close it, don't leak it
  // (StrictMode remount and unmount-before-open both hit this race).
  const epochRef = useRef(0);
  // Set once the shell has been spawned, so focus toggling never re-spawns it.
  const openedRef = useRef(false);

  // Spawn a fresh shell into this terminal (rooted in this workspace's cwd) and
  // wire its output back. The PTY's cwd is what makes the terminal match the
  // active workspace (spec 5.A.6 + Phase 5 per-workspace routing).
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
    reportExited(cwd, false);
    try {
      const id = await ptyOpen(
        (bytes) => {
          if (epochRef.current !== myEpoch) return; // superseded shell; ignore
          const t = termRef.current;
          if (!t) return;
          if (bytes.length === 0) {
            // EOF sentinel: the shell exited.
            ptyIdRef.current = null;
            reportExited(cwd, true);
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
        cwd,
      );
      if (epochRef.current !== myEpoch) {
        // Unmounted or restarted while `ptyOpen` was in flight: don't leak it.
        void ptyClose(id);
        return;
      }
      ptyIdRef.current = id;
    } catch {
      if (epochRef.current !== myEpoch) return;
      reportExited(cwd, true);
      try {
        term.write("\r\n\x1b[31m[failed to start shell]\x1b[0m\r\n");
      } catch {
        /* disposed */
      }
    }
  }, [cwd, reportExited]);

  // Disposer for the lazily-created xterm + its observers (set by ensureCreated).
  const cleanupRef = useRef<(() => void) | null>(null);
  const createdRef = useRef(false);

  // Create the xterm (+ PTY wiring) lazily, the FIRST time this workspace is
  // focused — so an unvisited workspace holds no terminal in the web process
  // (idle-memory win; perf-budget pass). Idempotent.
  const ensureCreated = useCallback(() => {
    if (createdRef.current) return;
    const host = hostRef.current;
    if (!host) return;
    createdRef.current = true;

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

    cleanupRef.current = () => {
      ro.disconnect();
      dataSub.dispose();
      term.dispose();
    };
  }, []);

  // Spawn the xterm + shell the first time this workspace is focused, then keep
  // both alive across later switches (just hidden when inactive).
  useEffect(() => {
    if (active && !openedRef.current) {
      ensureCreated();
      if (!termRef.current) return; // host not mounted yet (shouldn't happen)
      openedRef.current = true;
      void openShell();
    }
  }, [active, ensureCreated, openShell]);

  // Tear down on unmount (workspace closed): reap the PTY + dispose the xterm.
  useEffect(() => {
    return () => {
      epochRef.current++; // invalidate any in-flight open so it can't leak
      const id = ptyIdRef.current;
      if (id) void ptyClose(id);
      ptyIdRef.current = null;
      cleanupRef.current?.();
      cleanupRef.current = null;
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  const restart = useCallback(async () => {
    ensureCreated();
    const id = ptyIdRef.current;
    if (id) {
      await ptyClose(id);
      ptyIdRef.current = null;
    }
    termRef.current?.reset();
    openedRef.current = true;
    await openShell();
  }, [ensureCreated, openShell]);

  // Register restart with the parent header while mounted.
  useEffect(() => {
    registerRestart(cwd, restart);
    return () => registerRestart(cwd, null);
  }, [cwd, restart, registerRestart]);

  return (
    <div
      ref={hostRef}
      // All terminals share the body box (absolute inset-0); the inactive ones
      // stay laid-out-but-hidden so they keep correct size and switching needs
      // no reflow. `visibility` (not display:none) preserves xterm's geometry.
      style={{
        position: "absolute",
        inset: 0,
        visibility: active ? "visible" : "hidden",
        overflow: "hidden",
        background: "var(--color-bg-recessed)",
        padding: visible ? "var(--space-3)" : 0,
      }}
    />
  );
}

const headerText = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--color-fg-secondary)",
} as const;
