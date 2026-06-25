/*
 * Diff view (spec 5.A.3, Phase 4). A Monaco DiffEditor for one file's git diff.
 * Like VS Code: the WORKING-TREE side (modified, right) is EDITABLE — you type
 * there and Ctrl/Cmd-S (or Save) writes the real file, then refreshes the
 * source-control list. A STAGED diff (HEAD→index) is read-only, since you can't
 * edit the index directly. Rendered as a lazy overlay over the editor host so
 * Monaco stays out of the initial chunk and the open file models underneath are
 * never disturbed. New/untracked files show as all-added (empty left side);
 * deleted files as all-removed.
 *
 * Note: if the same file is also open in a plain editor tab, edits made here are
 * not yet live-synced to that tab (a shared-model unification is a follow-up);
 * the file on disk is always the last save.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { EmptyState, LoadingState } from "@/components/states";
import { languageForPath } from "@/editor/language";
import { defineClaudeTheme, MONACO_THEME } from "@/editor/monacoSetup";
import { checkpointDiff, gitDiff, writeFile } from "@/ipc/commands";
import { isIpcError } from "@/ipc/types";
import { useGit } from "@/store/git";
import type { EditorTab } from "@/store/editor";

interface Sides {
  original: string;
  modified: string;
}

type State =
  | { kind: "loading" }
  | { kind: "ready"; sides: Sides }
  | { kind: "binary" }
  | { kind: "error"; message: string };

export function DiffView({ tab, cwd }: { tab: EditorTab; cwd: string }) {
  const file = tab.diff?.file ?? "";
  const staged = tab.diff?.staged ?? false;
  const checkpoint = tab.diff?.checkpoint;
  // The working-tree (modified) side is editable like VS Code — but a staged
  // diff and a read-only checkpoint preview are not.
  const editable = !staged && !checkpoint;

  const [state, setState] = useState<State>({ kind: "loading" });
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const editorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);
  const savedVersionRef = useRef<number>(0);

  const ckptSession = checkpoint?.sessionId;
  const ckptVersion = checkpoint?.version;
  useEffect(() => {
    let alive = true;
    setState({ kind: "loading" });
    setDirty(false);
    setSaveError(null);
    // A checkpoint tab compares the saved snapshot (left) to the current file
    // (right); a git tab compares HEAD/index/working tree.
    const load: Promise<{ binary: boolean } & Sides> =
      ckptSession != null && ckptVersion != null
        ? checkpointDiff(ckptSession, file, ckptVersion, cwd).then((d) => ({
            binary: d.binary,
            original: d.snapshot,
            modified: d.current,
          }))
        : gitDiff(file, staged, cwd).then((d) => ({
            binary: d.binary,
            original: d.original,
            modified: d.modified,
          }));
    load
      .then((r) => {
        if (!alive) return;
        setState(r.binary ? { kind: "binary" } : { kind: "ready", sides: r });
      })
      .catch((e) => {
        if (!alive) return;
        setState({ kind: "error", message: isIpcError(e) ? e.message : "Could not load the diff" });
      });
    return () => {
      alive = false;
    };
  }, [file, staged, cwd, ckptSession, ckptVersion]);

  const save = useCallback(async () => {
    const ed = editorRef.current;
    if (!ed || !editable) return;
    const model = ed.getModifiedEditor().getModel();
    if (!model) return;
    try {
      await writeFile(file, model.getValue(), cwd);
      savedVersionRef.current = model.getAlternativeVersionId();
      setDirty(false);
      setSaveError(null);
      void useGit.getState().refresh();
    } catch (e) {
      setSaveError(isIpcError(e) ? e.message : "Save failed");
    }
  }, [file, editable, cwd]);

  // Wire dirty tracking + Ctrl/Cmd-S on the editable (modified) side at mount.
  const onMount: DiffOnMount = (editor, monaco) => {
    editorRef.current = editor;
    if (!editable) return;
    const model = editor.getModifiedEditor().getModel();
    if (!model) return;
    savedVersionRef.current = model.getAlternativeVersionId();
    model.onDidChangeContent(() => {
      setDirty(model.getAlternativeVersionId() !== savedVersionRef.current);
    });
    editor
      .getModifiedEditor()
      .addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save());
  };

  return (
    <div className="flex h-full w-full flex-col" style={{ background: "var(--color-bg-base)" }}>
      <Header
        file={file}
        badge={
          checkpoint
            ? `Snapshot @v${checkpoint.version} → current · read-only`
            : staged
              ? "Staged · read-only"
              : "Working tree · editable"
        }
        badgeOk={staged || !!checkpoint}
        showSave={editable}
        canSave={editable && dirty}
        onSave={() => void save()}
      />
      {saveError && <Banner text={saveError} />}
      <div className="relative min-h-0 flex-1">
        {state.kind === "ready" ? (
          <DiffEditor
            height="100%"
            language={languageForPath(file)}
            original={state.sides.original}
            modified={state.sides.modified}
            theme={MONACO_THEME}
            beforeMount={() => defineClaudeTheme()}
            onMount={onMount}
            options={{
              readOnly: !editable, // staged diffs are read-only; working-tree is editable
              originalEditable: false,
              renderSideBySide: true,
              automaticLayout: true,
              fontFamily: "var(--font-mono)",
              fontSize: 15,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              renderOverviewRuler: false,
              fixedOverflowWidgets: true,
            }}
          />
        ) : (
          <div className="absolute inset-0" style={{ background: "var(--color-bg-recessed)" }}>
            {state.kind === "loading" ? (
              <LoadingState label="Loading diff…" />
            ) : state.kind === "binary" ? (
              <EmptyState
                title="Binary file"
                hint="This file isn't text, so it can't be diffed in the editor."
              />
            ) : (
              <EmptyState title="Couldn't load diff" hint={state.message} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Header({
  file,
  badge,
  badgeOk,
  showSave,
  canSave,
  onSave,
}: {
  file: string;
  badge: string;
  badgeOk: boolean;
  showSave: boolean;
  canSave: boolean;
  onSave: () => void;
}) {
  return (
    <div
      className="flex shrink-0 items-center gap-[var(--space-3)]"
      style={{
        height: "var(--space-7)",
        padding: "0 var(--space-4)",
        background: "var(--color-bg-recessed)",
        borderBottom: "1px solid var(--color-border-subtle)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        color: "var(--color-fg-muted)",
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {file}
      </span>
      <span
        style={{
          padding: "1px var(--space-2)",
          borderRadius: "var(--radius-sm)",
          background: "var(--color-bg-raised)",
          color: badgeOk ? "var(--color-status-success)" : "var(--color-fg-secondary)",
          whiteSpace: "nowrap",
        }}
      >
        {badge}
      </span>
      {showSave && (
        <button
          type="button"
          onClick={onSave}
          disabled={!canSave}
          title="Save (Ctrl/Cmd-S)"
          className={canSave ? "ml-auto cursor-pointer" : "ml-auto"}
          style={{
            border: "none",
            background: "transparent",
            color: canSave ? "var(--color-accent)" : "var(--color-fg-muted)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            opacity: canSave ? 1 : 0.5,
          }}
        >
          {canSave ? "● Save" : "Save"}
        </button>
      )}
    </div>
  );
}

function Banner({ text }: { text: string }) {
  return (
    <div
      className="shrink-0"
      style={{
        padding: "var(--space-2) var(--space-4)",
        background: "var(--color-bg-recessed)",
        borderBottom: "1px solid var(--color-border-subtle)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        color: "var(--color-status-danger)",
      }}
    >
      {text}
    </div>
  );
}
