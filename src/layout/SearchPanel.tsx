/*
 * Search panel (spec 5.A.3). Two modes over one input:
 *   • Files (Phase 4) — workspace-wide find-in-files via ripgrep; click a line to
 *     open the file there.
 *   • Sessions (P5, Phase 8) — full-text search across the workspace's `claude`
 *     session transcripts (user + assistant message text); click a result to
 *     resume that conversation in the hero pane.
 * Both search as you type (debounced) and are capped backend-side so the payload
 * stays bounded.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { search, searchSessions } from "@/ipc/commands";
import { isIpcError, type SearchResults, type SessionSearchResults } from "@/ipc/types";
import { useActiveConversation } from "@/store/conversation";
import { useActiveEditor } from "@/store/editor";
import { effectiveFilesFor } from "@/store/settings";
import { useActiveCwd } from "@/store/workspaces";

type Mode = "files" | "sessions";

export function SearchPanel() {
  const cwd = useActiveCwd();
  const [mode, setMode] = useState<Mode>("files");
  const [query, setQuery] = useState("");
  const [fileResults, setFileResults] = useState<SearchResults | null>(null);
  const [sessionResults, setSessionResults] = useState<SessionSearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openAt = useActiveEditor((s) => s.openAt);
  const resume = useActiveConversation((s) => s.resume);
  const streaming = useActiveConversation((s) => s.streaming);
  const tokenRef = useRef(0);

  // Re-runs on query / mode / workspace change. The non-active mode's results
  // are cleared so a stale list from the other mode can never show.
  useEffect(() => {
    const q = query.trim();
    setFileResults(null);
    setSessionResults(null);
    if (!q) {
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const token = ++tokenRef.current;
    const timer = setTimeout(async () => {
      try {
        if (mode === "files") {
          const r = await search(q, cwd, effectiveFilesFor(cwd).exclude);
          if (token !== tokenRef.current) return;
          setFileResults(r);
        } else {
          const r = await searchSessions(q, cwd);
          if (token !== tokenRef.current) return;
          setSessionResults(r);
        }
        setError(null);
      } catch (e) {
        if (token !== tokenRef.current) return;
        setError(isIpcError(e) ? e.message : "Search failed");
      } finally {
        if (token === tokenRef.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query, cwd, mode]);

  const fileCount = fileResults?.files.length ?? 0;
  const summary =
    mode === "files"
      ? fileResults &&
        (fileResults.totalMatches === 0
          ? "No results"
          : `${fileResults.totalMatches} ${fileResults.totalMatches === 1 ? "result" : "results"} in ${fileCount} ${fileCount === 1 ? "file" : "files"}${fileResults.truncated ? " (showing the first matches)" : ""}`)
      : sessionResults &&
        (sessionResults.totalHits === 0
          ? "No results"
          : `${sessionResults.totalHits} ${sessionResults.totalHits === 1 ? "hit" : "hits"} in ${sessionResults.groups.length} ${sessionResults.groups.length === 1 ? "session" : "sessions"}${sessionResults.truncated ? " (showing the first matches)" : ""}`);

  return (
    <div className="flex h-full flex-col">
      <div
        className="shrink-0"
        style={{ padding: "var(--space-3) var(--space-4)", borderBottom: "1px solid var(--color-border-subtle)" }}
      >
        <div role="tablist" aria-label="Search scope" className="flex gap-[var(--space-1)]" style={{ marginBottom: "var(--space-2)" }}>
          <ModeTab label="Files" active={mode === "files"} onClick={() => setMode("files")} />
          <ModeTab label="Sessions" active={mode === "sessions"} onClick={() => setMode("sessions")} />
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={mode === "files" ? "Search workspace…" : "Search past conversations…"}
          aria-label={mode === "files" ? "Search workspace files" : "Search session transcripts"}
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
        {summary && (
          <p
            style={{
              marginTop: "var(--space-2)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--color-fg-muted)",
            }}
          >
            {summary}
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" style={{ padding: "var(--space-2) 0" }}>
        {error ? (
          <Note text={error} tone="error" />
        ) : loading && !fileResults && !sessionResults ? (
          <Note text="Searching…" />
        ) : !query.trim() ? (
          <Note
            text={
              mode === "files"
                ? "Type to search file contents across the workspace."
                : "Type to search across your past conversations in this workspace."
            }
          />
        ) : mode === "files" ? (
          fileResults?.files.map((file) => <FileGroup key={file.path} file={file} onOpen={openAt} />)
        ) : (
          sessionResults?.groups.map((group) => (
            <SessionGroup
              key={group.sessionId}
              group={group}
              query={query.trim()}
              disabled={streaming}
              onResume={() => void resume(group.sessionId)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function ModeTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className="cursor-pointer"
      style={{
        border: "none",
        borderRadius: "var(--radius-sm)",
        padding: "2px var(--space-2)",
        background: active ? "var(--color-accent-quiet)" : "transparent",
        color: active ? "var(--color-fg-primary)" : "var(--color-fg-muted)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
      }}
    >
      {label}
    </button>
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
                <Mark key={j}>{seg.text}</Mark>
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

function SessionGroup({
  group,
  query,
  disabled,
  onResume,
}: {
  group: SessionSearchResults["groups"][number];
  query: string;
  disabled: boolean;
  onResume: () => void;
}) {
  const more = group.hitCount - group.hits.length;
  return (
    <section style={{ marginBottom: "var(--space-3)" }}>
      <button
        type="button"
        onClick={onResume}
        disabled={disabled}
        title={disabled ? "Finish the current turn first" : `Resume: ${group.label}`}
        className={disabled ? "" : "cursor-pointer"}
        style={{
          display: "flex",
          width: "100%",
          alignItems: "center",
          gap: "var(--space-2)",
          border: "none",
          background: "transparent",
          padding: "var(--space-1) var(--space-4)",
          textAlign: "left",
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--color-fg-secondary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {group.label}
        </span>
        <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--color-fg-muted)" }}>
          {group.hitCount}
        </span>
      </button>
      {group.hits.map((hit, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            gap: "var(--space-2)",
            padding: "2px var(--space-4) 2px var(--space-6)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            lineHeight: 1.5,
          }}
        >
          <span style={{ flexShrink: 0, color: hit.role === "user" ? "var(--color-accent)" : "var(--color-fg-muted)" }}>
            {hit.role === "user" ? "you" : "ai"}
          </span>
          <span style={{ minWidth: 0, color: "var(--color-fg-secondary)", wordBreak: "break-word" }}>
            {highlight(hit.snippet, query).map((seg, j) =>
              seg.match ? <Mark key={j}>{seg.text}</Mark> : <span key={j}>{seg.text}</span>,
            )}
          </span>
        </div>
      ))}
      {more > 0 && (
        <div style={{ padding: "0 var(--space-4) 0 var(--space-6)", fontSize: "var(--text-xs)", color: "var(--color-fg-muted)" }}>
          +{more} more in this session
        </div>
      )}
    </section>
  );
}

/** Split a snippet into matched / unmatched segments (case-insensitive) so the
 *  query can be highlighted client-side. */
function highlight(text: string, query: string): { text: string; match: boolean }[] {
  if (!query) return [{ text, match: false }];
  const out: { text: string; match: boolean }[] = [];
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let i = 0;
  while (i < text.length) {
    const found = lower.indexOf(q, i);
    if (found === -1) {
      out.push({ text: text.slice(i), match: false });
      break;
    }
    if (found > i) out.push({ text: text.slice(i, found), match: false });
    out.push({ text: text.slice(found, found + q.length), match: true });
    i = found + q.length;
  }
  return out;
}

function Mark({ children }: { children: ReactNode }) {
  return (
    <mark
      style={{
        background: "var(--color-accent-quiet)",
        color: "var(--color-fg-primary)",
        borderRadius: "2px",
      }}
    >
      {children}
    </mark>
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
