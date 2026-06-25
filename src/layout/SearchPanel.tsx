/*
 * Global search panel (spec 5.A.3, Phase 4). A workspace-wide find-in-files
 * backed by ripgrep: type a query, see matches grouped by file with the hit
 * highlighted, click a line to open the file at that line. Searches as you type
 * (debounced); results are capped backend-side so the payload stays bounded.
 */

import { useEffect, useRef, useState } from "react";
import { search } from "@/ipc/commands";
import { isIpcError, type SearchResults } from "@/ipc/types";
import { useActiveEditor } from "@/store/editor";
import { useActiveCwd } from "@/store/workspaces";

export function SearchPanel() {
  const cwd = useActiveCwd();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openAt = useActiveEditor((s) => s.openAt);
  const tokenRef = useRef(0);

  // Re-runs on query change and on workspace switch (so results match the
  // active workspace, never the previous one).
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const token = ++tokenRef.current;
    const timer = setTimeout(async () => {
      try {
        const r = await search(q, cwd);
        if (token !== tokenRef.current) return; // a newer query superseded this one
        setResults(r);
        setError(null);
      } catch (e) {
        if (token !== tokenRef.current) return;
        setError(isIpcError(e) ? e.message : "Search failed");
        setResults(null);
      } finally {
        if (token === tokenRef.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query, cwd]);

  const fileCount = results?.files.length ?? 0;

  return (
    <div className="flex h-full flex-col">
      <div
        className="shrink-0"
        style={{ padding: "var(--space-3) var(--space-4)", borderBottom: "1px solid var(--color-border-subtle)" }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search workspace…"
          aria-label="Search workspace"
          spellCheck={false}
          autoFocus
          style={{
            width: "100%",
            padding: "var(--space-2)",
            background: "var(--color-bg-recessed)",
            border: "1px solid var(--color-border-strong)",
            borderRadius: "var(--radius-sm)",
            color: "var(--color-fg-primary)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            outline: "none",
          }}
        />
        {results && (
          <p
            style={{
              marginTop: "var(--space-2)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--color-fg-muted)",
            }}
          >
            {results.totalMatches === 0
              ? "No results"
              : `${results.totalMatches} ${results.totalMatches === 1 ? "result" : "results"} in ${fileCount} ${fileCount === 1 ? "file" : "files"}${results.truncated ? " (showing the first matches)" : ""}`}
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" style={{ padding: "var(--space-2) 0" }}>
        {error ? (
          <Note text={error} tone="error" />
        ) : loading && !results ? (
          <Note text="Searching…" />
        ) : !query.trim() ? (
          <Note text="Type to search file contents across the workspace." />
        ) : (
          results?.files.map((file) => <FileGroup key={file.path} file={file} onOpen={openAt} />)
        )}
      </div>
    </div>
  );
}

function FileGroup({
  file,
  onOpen,
}: {
  file: SearchResults["files"][number];
  onOpen: (path: string, line: number) => void;
}) {
  const slash = file.path.lastIndexOf("/");
  const name = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  const dir = slash >= 0 ? file.path.slice(0, slash) : "";

  return (
    <section style={{ marginBottom: "var(--space-2)" }}>
      <div
        className="flex items-center gap-[var(--space-2)]"
        style={{
          padding: "var(--space-1) var(--space-4)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
        }}
        title={file.path}
      >
        <span style={{ color: "var(--color-fg-secondary)" }}>{name}</span>
        {dir && (
          <span style={{ color: "var(--color-fg-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {dir}
          </span>
        )}
        <span style={{ marginLeft: "auto", color: "var(--color-fg-muted)" }}>{file.lines.length}</span>
      </div>
      {file.lines.map((line, i) => (
        <button
          key={`${line.lineNumber}:${i}`}
          type="button"
          onClick={() => onOpen(file.path, line.lineNumber)}
          title={`Open ${file.path}:${line.lineNumber}`}
          className="flex w-full cursor-pointer items-baseline gap-[var(--space-3)] text-left"
          style={{
            border: "none",
            background: "transparent",
            padding: "2px var(--space-4) 2px var(--space-6)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
          }}
        >
          <span style={{ flexShrink: 0, color: "var(--color-fg-muted)", minWidth: "2.5em", textAlign: "right" }}>
            {line.lineNumber}
          </span>
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--color-fg-secondary)",
            }}
          >
            {line.segments.map((seg, j) =>
              seg.isMatch ? (
                <mark
                  key={j}
                  style={{
                    background: "var(--color-accent-quiet)",
                    color: "var(--color-fg-primary)",
                    borderRadius: "2px",
                  }}
                >
                  {seg.text}
                </mark>
              ) : (
                <span key={j}>{seg.text}</span>
              ),
            )}
          </span>
        </button>
      ))}
    </section>
  );
}

function Note({ text, tone }: { text: string; tone?: "error" }) {
  return (
    <p
      style={{
        padding: "var(--space-2) var(--space-4)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        color: tone === "error" ? "var(--color-status-danger)" : "var(--color-fg-muted)",
        lineHeight: 1.5,
      }}
    >
      {text}
    </p>
  );
}
