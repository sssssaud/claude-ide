/*
 * File explorer (spec 5.A.3, Phase 4). A lazy tree of the workspace root: each
 * directory lists its children only when expanded (so `node_modules`/`target`
 * cost nothing until clicked), and a file click opens it in the editor. All
 * paths are workspace-root-relative and resolved/confined in the backend.
 */

import { useEffect, useMemo, useState } from "react";
import { listDir } from "@/ipc/commands";
import type { DirEntry } from "@/ipc/types";
import { isIpcError } from "@/ipc/types";
import { useActiveEditor } from "@/store/editor";
import { mergeEffectiveAppearance, mergeEffectiveFiles, useSettings } from "@/store/settings";
import { useActiveCwd } from "@/store/workspaces";

/** Drop names hidden by `files.exclude` (Addendum II §S6) — a client-side
 *  filter (the explorer already fetches lazily, per-directory; nothing to save
 *  server-side by excluding earlier). */
function filterExcluded(entries: DirEntry[], exclude: string[]): DirEntry[] {
  return exclude.length === 0 ? entries : entries.filter((e) => !exclude.includes(e.name));
}

export function FileExplorer() {
  const cwd = useActiveCwd();
  const [roots, setRoots] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const userFiles = useSettings((s) => s.user.files);
  const wsFiles = useSettings((s) => s.workspaces[cwd ?? ""]?.files);
  const exclude = useMemo(() => mergeEffectiveFiles(userFiles, wsFiles).exclude, [userFiles, wsFiles]);
  const userAppearance = useSettings((s) => s.user.appearance);
  const wsAppearance = useSettings((s) => s.workspaces[cwd ?? ""]?.appearance);
  const colorFileIcons = useMemo(
    () => mergeEffectiveAppearance(userAppearance, wsAppearance).colorFileIcons,
    [userAppearance, wsAppearance],
  );

  // Re-root whenever the active workspace changes: reload the top level and
  // (via the keyed wrapper below) reset every expanded node's state.
  useEffect(() => {
    let alive = true;
    setRoots(null);
    setError(null);
    listDir(undefined, cwd)
      .then((entries) => alive && setRoots(entries))
      .catch((e) => alive && setError(isIpcError(e) ? e.message : "Could not read the folder"));
    return () => {
      alive = false;
    };
  }, [cwd]);

  const visibleRoots = roots ? filterExcluded(roots, exclude) : roots;

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto" style={{ padding: "var(--space-2) 0" }}>
        {error ? (
          <Note text={error} tone="error" />
        ) : !visibleRoots ? (
          <Note text="Loading…" />
        ) : visibleRoots.length === 0 ? (
          <Note text="Empty folder." />
        ) : (
          // Keyed on cwd so switching workspaces remounts the tree (fresh expansion).
          <div key={cwd ?? "default"}>
            {visibleRoots.map((entry) => (
              <TreeNode key={entry.path} entry={entry} depth={0} cwd={cwd} exclude={exclude} colorFileIcons={colorFileIcons} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TreeNode({
  entry,
  depth,
  cwd,
  exclude,
  colorFileIcons,
}: {
  entry: DirEntry;
  depth: number;
  cwd: string | undefined;
  exclude: string[];
  colorFileIcons: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const activePath = useActiveEditor((s) => s.activePath);
  const open = useActiveEditor((s) => s.open);
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
        setChildren(filterExcluded(await listDir(entry.path, cwd), exclude));
      } catch {
        setChildren([]);
      } finally {
        setLoading(false);
      }
    }
  };

  const iconColor = entry.isDir ? undefined : colorFileIcons ? fileIconColor(entry.name) : undefined;

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
        <span aria-hidden="true" className="inline-flex items-center justify-center" style={{ width: "1em" }}>
          {/* Emoji glyphs render in full color regardless of CSS `color` — so a
              known extension gets a small color-coded swatch instead, the one
              way this setting is actually visible. */}
          {iconColor ? (
            <span style={{ width: "8px", height: "8px", borderRadius: "2px", background: iconColor, display: "inline-block" }} />
          ) : entry.isDir ? (
            "📁"
          ) : (
            "📄"
          )}
        </span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{entry.name}</span>
      </button>
      {entry.isDir && expanded && (
        <>
          {loading && <Note text="…" depth={depth + 1} />}
          {children?.map((child) => (
            <TreeNode key={child.path} entry={child} depth={depth + 1} cwd={cwd} exclude={exclude} colorFileIcons={colorFileIcons} />
          ))}
        </>
      )}
    </>
  );
}

// Common-extension accent colors for the file tree (Addendum II §S6, "Color
// File Icons") — content/file-type coloring, the same category as Monaco's own
// literal syntax-theme colors (`editor/monacoSetup.ts`), not app chrome, so
// it's exempt from the tokens-only rule.
const EXT_COLORS: Record<string, string> = {
  ts: "#3178c6",
  tsx: "#3178c6",
  js: "#f0db4f",
  jsx: "#f0db4f",
  mjs: "#f0db4f",
  json: "#cbcb41",
  rs: "#dea584",
  toml: "#9c4221",
  css: "#42a5f5",
  html: "#e34c26",
  md: "#8a8f98",
  py: "#3776ab",
  yml: "#cb171e",
  yaml: "#cb171e",
  sh: "#89e051",
  svg: "#ffb13b",
  png: "#a074c4",
  jpg: "#a074c4",
  jpeg: "#a074c4",
};

function fileIconColor(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return EXT_COLORS[name.slice(dot + 1).toLowerCase()];
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
