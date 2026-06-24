/*
 * File explorer (spec 5.A.3, Phase 4). A lazy tree of the workspace root: each
 * directory lists its children only when expanded (so `node_modules`/`target`
 * cost nothing until clicked), and a file click opens it in the editor. All
 * paths are workspace-root-relative and resolved/confined in the backend.
 */

import { useEffect, useState } from "react";
import { listDir } from "@/ipc/commands";
import type { DirEntry } from "@/ipc/types";
import { isIpcError } from "@/ipc/types";
import { useEditor } from "@/store/editor";

export function FileExplorer() {
  const [roots, setRoots] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listDir()
      .then((entries) => alive && setRoots(entries))
      .catch((e) => alive && setError(isIpcError(e) ? e.message : "Could not read the folder"));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto" style={{ padding: "var(--space-2) 0" }}>
        {error ? (
          <Note text={error} tone="error" />
        ) : !roots ? (
          <Note text="Loading…" />
        ) : roots.length === 0 ? (
          <Note text="Empty folder." />
        ) : (
          roots.map((entry) => <TreeNode key={entry.path} entry={entry} depth={0} />)
        )}
      </div>
    </div>
  );
}

function TreeNode({ entry, depth }: { entry: DirEntry; depth: number }) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const activePath = useEditor((s) => s.activePath);
  const open = useEditor((s) => s.open);
  const active = !entry.isDir && activePath === entry.path;

  const onClick = async () => {
    if (!entry.isDir) {
      open(entry.path);
      return;
    }
    const next = !expanded;
    setExpanded(next);
    if (next && children === null) {
      setLoading(true);
      try {
        setChildren(await listDir(entry.path));
      } catch {
        setChildren([]);
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void onClick()}
        title={entry.name}
        className="flex w-full cursor-pointer items-center gap-[var(--space-2)]"
        style={{
          border: "none",
          background: active ? "var(--color-accent-quiet)" : "transparent",
          color: active ? "var(--color-fg-primary)" : "var(--color-fg-secondary)",
          padding: "3px var(--space-3)",
          paddingLeft: `calc(${depth} * 12px + var(--space-3))`,
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          textAlign: "left",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        <span aria-hidden="true" style={{ width: "0.8em", color: "var(--color-fg-muted)" }}>
          {entry.isDir ? (expanded ? "▾" : "▸") : ""}
        </span>
        <span aria-hidden="true">{entry.isDir ? "📁" : "📄"}</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{entry.name}</span>
      </button>
      {entry.isDir && expanded && (
        <>
          {loading && <Note text="…" depth={depth + 1} />}
          {children?.map((child) => (
            <TreeNode key={child.path} entry={child} depth={depth + 1} />
          ))}
        </>
      )}
    </>
  );
}

function Note({ text, tone, depth = 0 }: { text: string; tone?: "error"; depth?: number }) {
  return (
    <p
      style={{
        padding: "var(--space-1) var(--space-3)",
        paddingLeft: `calc(${depth} * 12px + var(--space-3))`,
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        color: tone === "error" ? "var(--color-status-danger)" : "var(--color-fg-muted)",
      }}
    >
      {text}
    </p>
  );
}
