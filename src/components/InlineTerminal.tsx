/*
 * A small, self-contained one-shot terminal (Addendum II §S2.5): opens a PTY,
 * types one command into it immediately, and reports back when the shell
 * exits. Built to host `claude auth login` — an interactive, CLI-owned flow
 * (opens a browser/OAuth page, sometimes an SSO or email-code step) — wherever
 * the app needs it, including the Preflight gate where the full Terminal
 * drawer isn't mounted yet (preflight must never spawn anything before auth is
 * confirmed). Never hand-rolls the login itself: the CLI's own flow plays out
 * exactly as it would in a real terminal.
 */

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ptyClose, ptyOpen, ptyWrite } from "@/ipc/commands";

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Runs `command` once on mount. Give it a fresh `key` at the call site to
 *  re-run (it's intentionally one-shot per mount, not reactive to prop changes). */
export function InlineTerminal({ command, onExit }: { command: string; onExit?: () => void }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  // Kept fresh every render but read only inside the mount-effect's callbacks,
  // so a new `onExit` identity never re-triggers the (intentionally one-shot)
  // effect below.
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  useEffect(() => {
    let disposed = false;
    const term = new Terminal({
      fontFamily: token("--font-mono") || "monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 2000,
      theme: {
        background: token("--color-bg-recessed"),
        foreground: token("--color-fg-primary"),
        cursor: token("--color-accent"),
        selectionBackground: token("--color-accent-quiet"),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    if (hostRef.current) term.open(hostRef.current);
    try {
      fit.fit();
    } catch {
      /* container momentarily zero-sized */
    }
    // The host panel can mount far from the button that triggered it (e.g.
    // Install in the browse list, terminal at the section top) — bring it
    // into view so the click visibly does something.
    hostRef.current?.scrollIntoView({ block: "nearest" });

    const dataSub = term.onData((d) => {
      const id = ptyIdRef.current;
      if (id) void ptyWrite(id, d);
    });
    const ro = new ResizeObserver(() => {
      if (disposed) return;
      try {
        fit.fit();
      } catch {
        /* zero-sized */
      }
    });
    if (hostRef.current) ro.observe(hostRef.current);

    void (async () => {
      try {
        const id = await ptyOpen(
          (bytes) => {
            if (disposed) return;
            if (bytes.length === 0) {
              onExitRef.current?.(); // EOF sentinel: the shell (and our one command) exited
              return;
            }
            try {
              term.write(bytes);
            } catch {
              /* terminal already disposed */
            }
          },
          term.rows,
          term.cols,
        );
        if (disposed) {
          void ptyClose(id);
          return;
        }
        ptyIdRef.current = id;
        // `; exit` makes this genuinely one-shot: the PTY spawns an
        // interactive $SHELL, and without it the shell just returns to a
        // prompt when the command ends — the EOF sentinel never fires, so
        // onExit (list refresh, "Running…" teardown) never runs. The command
        // itself stays fully interactive (auth login prompts etc.); the shell
        // exits only after it finishes (Ctrl-C included).
        void ptyWrite(id, `${command}; exit\n`);
      } catch {
        if (!disposed) term.write("\r\n\x1b[31m[failed to start terminal]\x1b[0m\r\n");
      }
    })();

    return () => {
      disposed = true;
      ro.disconnect();
      dataSub.dispose();
      const id = ptyIdRef.current;
      if (id) void ptyClose(id);
      term.dispose();
    };
    // Intentionally one-shot per mount (see the doc comment above); give this
    // component a fresh `key` at the call site to run a different command.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={hostRef}
      role="group"
      aria-label="Sign-in terminal"
      style={{
        height: "220px",
        background: "var(--color-bg-recessed)",
        border: "1px solid var(--color-border-subtle)",
        borderRadius: "var(--radius-md)",
        padding: "var(--space-2)",
      }}
    />
  );
}
