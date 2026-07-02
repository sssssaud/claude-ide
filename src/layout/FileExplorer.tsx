/*
 * File explorer (spec 5.A.3, Phase 4). A lazy tree of the workspace root: each
 * directory lists its children only when expanded (so `node_modules`/`target`
 * cost nothing until clicked), and a file click opens it in the editor. All
 * paths are workspace-root-relative and resolved/confined in the backend.
 *
 * Addendum II §S7 adds a right-click context menu: New File/Folder, Duplicate,
 * Copy Path / Copy Relative Path, Reveal in File Manager, and Open Terminal
 * Here. Every mutating action goes through a backend command that validates
 * containment server-side (`files::resolve_within`'s documented pattern) —
 * this menu never constructs a raw filesystem path itself.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createEntry,
  duplicateFile,
  listDir,
  ptyWrite,
  revealInFileManager,
} from "@/ipc/commands";
import type { DirEntry } from "@/ipc/types";
import { isIpcError } from "@/ipc/types";
import { shellQuote } from "@/lib/shell";
import { getActivePtyId } from "@/store/activeTerminals";
import { useActiveEditor } from "@/store/editor";
import { useLayout } from "@/store/layout";
import { mergeEffectiveAppearance, mergeEffectiveFiles, useSettings } from "@/store/settings";
import { useActiveCwd } from "@/store/workspaces";

/** Drop names hidden by `files.exclude` (Addendum II §S6) — a client-side
 *  filter (the explorer already fetches lazily, per-directory; nothing to save
 *  server-side by excluding earlier). */
function filterExcluded(entries: DirEntry[], exclude: string[]): DirEntry[] {
  return exclude.length === 0 ? entries : entries.filter((e) => !exclude.includes(e.name));
}

/** The directory a "New File/Folder" or "Open Terminal Here" targeting `entry`
 *  should act in: the entry itself if it's a folder, else its parent. `null`
 *  entry (right-click on empty space) targets the workspace root. */
function targetDir(entry: DirEntry | null): string {
  if (!entry) return "";
  if (entry.isDir) return entry.path;
  const i = entry.path.lastIndexOf("/");
  return i === -1 ? "" : entry.path.slice(0, i);
}

export function FileExplorer() {
  const cwd = useActiveCwd();
  const [roots, setRoots] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: DirEntry | null } | null>(null);
  const [nameModal, setNameModal] = useState<{ mode: "file" | "folder"; parent: string } | null>(null);
  // Bumps force a specific directory's TreeNode (or the root, key "") to
  // refetch its children after a create/duplicate lands in it.
  const [refreshTick, setRefreshTick] = useState<Record<string, number>>({});
  const bumpRefresh = useCallback((dir: string) => {
    setRefreshTick((r) => ({ ...r, [dir]: (r[dir] ?? 0) + 1 }));
  }, []);

  const userFiles = useSettings((s) => s.user.files);
  const wsFiles = useSettings((s) => s.workspaces[cwd ?? ""]?.files);
  const exclude = useMemo(() => mergeEffectiveFiles(userFiles, wsFiles).exclude, [userFiles, wsFiles]);
  const userAppearance = useSettings((s) => s.user.appearance);
  const wsAppearance = useSettings((s) => s.workspaces[cwd ?? ""]?.appearance);
  const colorFileIcons = useMemo(
    () => mergeEffectiveAppearance(userAppearance, wsAppearance).colorFileIcons,
    [userAppearance, wsAppearance],
  );

  const rootTick = refreshTick[""] ?? 0;

  // Re-root whenever the active workspace changes (or the root itself is
  // refreshed): reload the top level and (via the keyed wrapper below) reset
  // every expanded node's state.
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
  }, [cwd, rootTick]);

  const visibleRoots = roots ? filterExcluded(roots, exclude) : roots;

  const openMenu = (e: React.MouseEvent, entry: DirEntry | null) => {
    e.preventDefault();
    e.stopPropagation();
    setActionError(null);
    setMenu({ x: e.clientX, y: e.clientY, entry });
  };

  const openTerminalHere = (dir: string) => {
    setMenu(null);
    const abs = dir ? `${cwd}/${dir}` : cwd;
    if (!cwd || !abs) return;
    useLayout.getState().setVisible("terminal", true);
    useLayout.getState().setBottomTab("terminal");
    const ptyId = getActivePtyId(cwd);
    if (ptyId) void ptyWrite(ptyId, `cd ${shellQuote(abs)} && clear\n`);
  };

  const copyToClipboard = (text: string) => {
    setMenu(null);
    void navigator.clipboard?.writeText(text);
  };

  const reveal = async (entry: DirEntry) => {
    setMenu(null);
    try {
      await revealInFileManager(entry.path, cwd);
    } catch (e) {
      setActionError(isIpcError(e) ? e.message : "Could not open the file manager");
    }
  };

  const duplicate = async (entry: DirEntry) => {
    setMenu(null);
    try {
      await duplicateFile(entry.path, cwd);
      bumpRefresh(targetDir(entry));
    } catch (e) {
      setActionError(isIpcError(e) ? e.message : "Could not duplicate the file");
    }
  };

  const submitName = async (name: string) => {
    if (!nameModal) return;
    try {
      await createEntry(nameModal.parent, name, nameModal.mode === "folder", cwd);
      bumpRefresh(nameModal.parent);
      setNameModal(null);
    } catch (e) {
      throw new Error(isIpcError(e) ? e.message : `Could not create the ${nameModal.mode}`);
    }
  };

  return (
    <div className="relative flex h-full flex-col" onContextMenu={(e) => openMenu(e, null)}>
      {actionError && (
        <div role="alert" className="shrink-0" style={{ padding: "var(--space-2) var(--space-3)", background: "var(--color-bg-recessed)", borderBottom: "1px solid var(--color-border-subtle)", color: "var(--color-status-danger)", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}>
          {actionError}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto" style={{ padding: "var(--space-2) 0" }}>
        {error ? (
          <Note text={error} tone="error" />
        ) : !visibleRoots ? (
          <Note text="Loading…" />
        ) : visibleRoots.length === 0 ? (
          <Note text="Empty folder. Right-click to create a file." />
        ) : (
          // Keyed on cwd so switching workspaces remounts the tree (fresh expansion).
          <div key={cwd ?? "default"}>
            {visibleRoots.map((entry) => (
              <TreeNode
                key={entry.path}
                entry={entry}
                depth={0}
                cwd={cwd}
                exclude={exclude}
                colorFileIcons={colorFileIcons}
                refreshTick={refreshTick}
                onContextMenu={openMenu}
              />
            ))}
          </div>
        )}
      </div>
      {menu && (
        <ExplorerMenu
          x={menu.x}
          y={menu.y}
          entry={menu.entry}
          onClose={() => setMenu(null)}
          onNewFile={() => {
            setNameModal({ mode: "file", parent: targetDir(menu.entry) });
            setMenu(null);
          }}
          onNewFolder={() => {
            setNameModal({ mode: "folder", parent: targetDir(menu.entry) });
            setMenu(null);
          }}
          onDuplicate={menu.entry && !menu.entry.isDir ? () => void duplicate(menu.entry as DirEntry) : undefined}
          onCopyPath={menu.entry ? () => copyToClipboard(`${cwd}/${menu.entry?.path}`) : undefined}
          onCopyRelativePath={menu.entry ? () => copyToClipboard(menu.entry?.path ?? "") : undefined}
          onReveal={menu.entry ? () => void reveal(menu.entry as DirEntry) : undefined}
          onOpenTerminalHere={() => openTerminalHere(targetDir(menu.entry))}
        />
      )}
      {nameModal && (
        <NameModal
          mode={nameModal.mode}
          onCancel={() => setNameModal(null)}
          onSubmit={submitName}
        />
      )}
    </div>
  );
}

function TreeNode({
  entry,
  depth,
  cwd,
  exclude,
  colorFileIcons,
  refreshTick,
  onContextMenu,
}: {
  entry: DirEntry;
  depth: number;
  cwd: string | undefined;
  exclude: string[];
  colorFileIcons: boolean;
  refreshTick: Record<string, number>;
  onContextMenu: (e: React.MouseEvent, entry: DirEntry) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const activePath = useActiveEditor((s) => s.activePath);
  const open = useActiveEditor((s) => s.open);
  const active = !entry.isDir && activePath === entry.path;
  const childrenLoadedRef = useRef(false);
  useEffect(() => {
    childrenLoadedRef.current = children !== null;
  }, [children]);

  const loadChildren = useCallback(async () => {
    setLoading(true);
    try {
      setChildren(filterExcluded(await listDir(entry.path, cwd), exclude));
    } catch {
      setChildren([]);
    } finally {
      setLoading(false);
    }
  }, [entry.path, cwd, exclude]);

  // A create/duplicate targeting this directory bumps its tick — refetch, but
  // only if we've already loaded it once (an unopened node just shows fresh
  // contents whenever it's next expanded; no need to fetch pre-emptively).
  const tick = refreshTick[entry.path] ?? 0;
  useEffect(() => {
    if (tick === 0 || !childrenLoadedRef.current) return;
    void loadChildren();
  }, [tick, loadChildren]);

  const onClick = async () => {
    if (!entry.isDir) {
      open(entry.path);
      return;
    }
    const next = !expanded;
    setExpanded(next);
    if (next && children === null) void loadChildren();
  };

  const iconColor = entry.isDir ? undefined : colorFileIcons ? fileIconColor(entry.name) : undefined;

  return (
    <>
      <button
        type="button"
        onClick={() => void onClick()}
        onContextMenu={(e) => onContextMenu(e, entry)}
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
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              cwd={cwd}
              exclude={exclude}
              colorFileIcons={colorFileIcons}
              refreshTick={refreshTick}
              onContextMenu={onContextMenu}
            />
          ))}
        </>
      )}
    </>
  );
}

// ---- Context menu (Addendum II §S7) ------------------------------------------

function ExplorerMenu({
  x,
  y,
  entry,
  onClose,
  onNewFile,
  onNewFolder,
  onDuplicate,
  onCopyPath,
  onCopyRelativePath,
  onReveal,
  onOpenTerminalHere,
}: {
  x: number;
  y: number;
  entry: DirEntry | null;
  onClose: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onDuplicate?: () => void;
  onCopyPath?: () => void;
  onCopyRelativePath?: () => void;
  onReveal?: () => void;
  onOpenTerminalHere: () => void;
}) {
  // Keep the menu on-screen near the click point rather than off the right/
  // bottom edge; a fixed generous estimate is fine for a short, fixed-width menu.
  const style = {
    position: "fixed" as const,
    left: Math.min(x, window.innerWidth - 240),
    top: Math.min(y, window.innerHeight - 260),
    zIndex: 31,
    minWidth: "220px",
    background: "var(--color-bg-raised)",
    border: "1px solid var(--color-border-strong)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-2)",
    boxShadow: "0 8px 24px rgba(0, 0, 0, 0.4)",
  };

  return (
    <>
      <div onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} className="fixed inset-0" style={{ zIndex: 30 }} aria-hidden="true" />
      <div
        role="menu"
        aria-label={entry ? entry.name : "Explorer"}
        style={style}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <MenuItem label="New File…" onClick={onNewFile} />
        <MenuItem label="New Folder…" onClick={onNewFolder} />
        {onDuplicate && <MenuItem label="Duplicate" onClick={onDuplicate} />}
        {(onCopyPath || onCopyRelativePath) && <MenuDivider />}
        {onCopyPath && <MenuItem label="Copy Path" onClick={onCopyPath} />}
        {onCopyRelativePath && <MenuItem label="Copy Relative Path" onClick={onCopyRelativePath} />}
        <MenuDivider />
        {onReveal && <MenuItem label="Reveal in File Manager" onClick={onReveal} />}
        <MenuItem label="Open Terminal Here" onClick={onOpenTerminalHere} />
      </div>
    </>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center text-left"
      style={{
        padding: "var(--space-2) var(--space-3)",
        border: "none",
        borderRadius: "var(--radius-sm)",
        background: "transparent",
        color: "var(--color-fg-primary)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-sm)",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--color-bg-recessed)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      {label}
    </button>
  );
}

function MenuDivider() {
  return <div style={{ margin: "var(--space-2) 0", borderTop: "1px solid var(--color-border-subtle)" }} />;
}

// ---- New file/folder name prompt ----------------------------------------------

function NameModal({
  mode,
  onCancel,
  onSubmit,
}: {
  mode: "file" | "folder";
  onCancel: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(n);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create it");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={mode === "file" ? "New file" : "New folder"}
      className="fixed inset-0 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.45)", zIndex: 32 }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        } else if (e.key === "Enter") {
          e.preventDefault();
          void submit();
        }
      }}
    >
      <div style={{ width: "min(380px, 90%)", padding: "var(--space-6)", borderRadius: "var(--radius-lg)", background: "var(--color-bg-overlay)", boxShadow: "var(--elev-3)" }}>
        <p style={{ color: "var(--color-fg-primary)", fontSize: "var(--text-md)", fontWeight: 600 }}>
          {mode === "file" ? "New File" : "New Folder"}
        </p>
        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={mode === "file" ? "name.txt" : "folder-name"}
          className="w-full"
          style={{ marginTop: "var(--space-4)", height: "var(--space-8)", padding: "0 var(--space-3)", border: "1px solid var(--color-border-strong)", borderRadius: "var(--radius-md)", background: "var(--color-bg-base)", color: "var(--color-fg-primary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}
        />
        {error && (
          <p role="alert" style={{ marginTop: "var(--space-2)", color: "var(--color-status-danger)", fontSize: "var(--text-xs)" }}>
            {error}
          </p>
        )}
        <div className="flex justify-end gap-[var(--space-3)]" style={{ marginTop: "var(--space-5)" }}>
          <button
            type="button"
            onClick={onCancel}
            className="cursor-pointer"
            style={{ padding: "var(--space-2) var(--space-5)", borderRadius: "var(--radius-md)", border: "1px solid var(--color-border-strong)", background: "transparent", color: "var(--color-fg-primary)", fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)" }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!name.trim() || busy}
            className="cursor-pointer"
            style={{ padding: "var(--space-2) var(--space-5)", borderRadius: "var(--radius-md)", border: "1px solid var(--color-accent)", background: "var(--color-accent)", color: "var(--color-bg-base)", fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)", fontWeight: 500, opacity: !name.trim() || busy ? 0.5 : 1 }}
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
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
