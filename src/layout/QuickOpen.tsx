/*
 * Quick Open (Addendum II §S3, §2.1): Ctrl/Cmd+P, fuzzy across every file in
 * the active workspace (respecting `.gitignore`, via the backend's `rg
 * --files`), Enter opens it in the editor. Loading/error surface as the
 * overlay's empty-state text (no separate spinner UI needed for a list this
 * shape) — fetched fresh each time it opens, not cached (files come and go).
 */

import { useEffect, useState } from "react";
import { listFiles } from "@/ipc/commands";
import { isIpcError } from "@/ipc/types";
import { FuzzyOverlay } from "@/layout/FuzzyOverlay";
import { activeEditorStore } from "@/store/editor";
import { useLayout } from "@/store/layout";
import { useOverlays } from "@/store/overlays";
import { useActiveCwd } from "@/store/workspaces";

export function QuickOpen() {
  const open = useOverlays((s) => s.quickOpen);
  const close = useOverlays((s) => s.closeQuickOpen);
  const cwd = useActiveCwd();

  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void listFiles(cwd ?? undefined)
      .then((f) => {
        if (!cancelled) {
          setFiles(f);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(isIpcError(e) ? e.message : "Could not list files");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, cwd]);

  const emptyLabel = loading ? "Loading files…" : (error ?? "No matching files.");

  return (
    <FuzzyOverlay<string>
      open={open}
      onClose={close}
      placeholder="Go to file…"
      ariaLabel="Quick Open"
      emptyLabel={emptyLabel}
      items={loading || error ? [] : files}
      itemKey={(f) => f}
      itemText={(f) => f}
      onSelect={(f) => {
        useLayout.getState().setVisible("editor", true);
        activeEditorStore().getState().open(f);
      }}
      renderItem={(f) => <QuickOpenRow path={f} />}
    />
  );
}

function QuickOpenRow({ path }: { path: string }) {
  const i = path.lastIndexOf("/");
  const name = i >= 0 ? path.slice(i + 1) : path;
  const dir = i >= 0 ? path.slice(0, i) : "";
  return (
    <div style={{ padding: "var(--space-3)" }}>
      <span style={{ color: "var(--color-fg-primary)", fontSize: "var(--text-sm)" }}>{name}</span>
      {dir && (
        <span style={{ marginLeft: "var(--space-3)", color: "var(--color-fg-muted)", fontSize: "var(--text-xs)" }}>
          {dir}
        </span>
      )}
    </div>
  );
}
