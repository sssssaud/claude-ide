/*
 * Settings view (Addendum II §1 + staged-apply revision). Opens as a closable
 * EDITOR TAB (see `editor.openSettings`), VS Code-style. A left rail of
 * categories, a searchable list of controls, and a User/Workspace scope toggle.
 *
 * Editing is STAGED: controls edit a draft (in the settings store); nothing
 * changes in the editor until you hit Apply. Closing the tab with unapplied
 * changes prompts first. Everything is data — numbers are bounded by the inputs
 * (and clamped server-side), the wrap mode is a fixed allow-list, and a bad JSON
 * edit is refused, not run. Tokens only, keyboard-operable, three states present.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { ThemePicker } from "@/layout/ThemePicker";
import type { EditorSettings, SettingsScope, WordWrap } from "@/ipc/types";
import { EDITOR_DEFAULTS, EDITOR_KEYS, useSettings } from "@/store/settings";
import { useActiveCwd } from "@/store/workspaces";

type Category = "editor" | "appearance";

const CATEGORIES: { id: Category; label: string }[] = [
  { id: "editor", label: "Text Editor" },
  { id: "appearance", label: "Appearance" },
];

interface ControlDef {
  key: keyof EditorSettings;
  label: string;
  description: string;
  keywords: string;
  kind: "text" | "number" | "boolean" | "select";
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
}

const EDITOR_CONTROLS: ControlDef[] = [
  { key: "fontFamily", label: "Font Family", description: "Controls the editor font. Leave empty to use the app's mono font.", keywords: "typeface mono", kind: "text" },
  { key: "fontSize", label: "Font Size", description: "Editor font size in pixels.", keywords: "zoom text size", kind: "number", min: 6, max: 72 },
  { key: "fontLigatures", label: "Font Ligatures", description: "Enable programming ligatures (requires a font that has them).", keywords: "ligature", kind: "boolean" },
  {
    key: "wordWrap",
    label: "Word Wrap",
    description: "How long lines wrap in the editor.",
    keywords: "wrap lines",
    kind: "select",
    options: [
      { value: "off", label: "Off" },
      { value: "on", label: "On" },
      { value: "wordWrapColumn", label: "At column" },
      { value: "bounded", label: "Bounded" },
    ],
  },
  { key: "wordWrapColumn", label: "Word Wrap Column", description: "The column to wrap at, for the “At column” and “Bounded” modes.", keywords: "wrap column ruler", kind: "number", min: 20, max: 400 },
  { key: "tabSize", label: "Tab Size", description: "The number of spaces a tab is equal to.", keywords: "indent indentation tab", kind: "number", min: 1, max: 16 },
  { key: "insertSpaces", label: "Insert Spaces", description: "Insert spaces when pressing Tab.", keywords: "indent spaces tab", kind: "boolean" },
  { key: "minimap", label: "Minimap", description: "Show the code overview minimap on the right edge.", keywords: "overview map", kind: "boolean" },
];

export function SettingsView() {
  const loaded = useSettings((s) => s.loaded);
  const loadError = useSettings((s) => s.loadError);
  const saveError = useSettings((s) => s.saveError);
  const scope = useSettings((s) => s.scope);
  const draft = useSettings((s) => s.draft);
  const dirty = useSettings((s) => s.dirty);
  const confirmingClose = useSettings((s) => s.confirmingClose);
  const user = useSettings((s) => s.user);
  const cwd = useActiveCwd();

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category>("editor");
  const [jsonMode, setJsonMode] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Load the document and stage a fresh draft when the tab opens.
  useEffect(() => {
    const s = useSettings.getState();
    if (!s.loaded) void s.load();
    s.beginEditing();
    searchRef.current?.focus();
  }, []);

  const workspaceUnavailable = scope === "workspace" && !cwd;

  // What a control shows when this scope hasn't set it: the User value (for the
  // workspace scope) or the built-in default.
  const fallback = <K extends keyof EditorSettings>(key: K): NonNullable<EditorSettings[K]> => {
    if (scope === "workspace" && user[key] !== undefined && user[key] !== null) {
      return user[key] as NonNullable<EditorSettings[K]>;
    }
    return EDITOR_DEFAULTS[key] as unknown as NonNullable<EditorSettings[K]>;
  };

  const q = query.trim().toLowerCase();
  const matches = (c: ControlDef) =>
    !q || c.label.toLowerCase().includes(q) || c.description.toLowerCase().includes(q) || c.keywords.toLowerCase().includes(q);
  const themeMatches = !q || "theme appearance color palette dark light".includes(q);
  const visibleEditor = useMemo(
    () => (q ? EDITOR_CONTROLS.filter(matches) : category === "editor" ? EDITOR_CONTROLS : []),
    [q, category],
  );
  const showAppearance = q ? themeMatches : category === "appearance";
  const nothingFound = !!q && visibleEditor.length === 0 && !themeMatches;

  return (
    <section aria-label="Settings" className="relative flex h-full w-full flex-col" style={{ background: "var(--color-bg-base)" }}>
      <Header
        scope={scope}
        cwd={cwd}
        query={query}
        setQuery={setQuery}
        searchRef={searchRef}
        jsonMode={jsonMode}
        setJsonMode={setJsonMode}
      />

      {saveError && <Banner tone="error" text={saveError} />}

      {!loaded ? (
        <LoadingState label="Loading settings…" />
      ) : loadError ? (
        <ErrorState title="Couldn't load settings" error={{ kind: "internal", message: loadError }} onRetry={() => void useSettings.getState().load()} />
      ) : jsonMode ? (
        <JsonEditor editor={draft} onDone={() => setJsonMode(false)} />
      ) : (
        <div className="flex min-h-0 flex-1">
          {!q && <CategoryRail active={category} onPick={setCategory} />}
          <div className="min-h-0 flex-1 overflow-auto" style={{ padding: "var(--space-6) var(--space-7)" }}>
            <div style={{ maxWidth: "760px", margin: "0 auto" }}>
              {workspaceUnavailable && <Note text="Open a folder to set Workspace-scoped settings. Showing defaults; edits are disabled." />}
              {nothingFound ? (
                <EmptyState title="No matching settings" hint={`Nothing matches “${query.trim()}”.`} />
              ) : (
                <>
                  {!q && (
                    <h2 style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "var(--space-3)" }}>
                      {CATEGORIES.find((c) => c.id === category)?.label}
                    </h2>
                  )}
                  <div className="flex flex-col">
                    {visibleEditor.map((c) => (
                      <ControlRow
                        key={c.key}
                        def={c}
                        value={draft[c.key] ?? fallback(c.key)}
                        isSet={draft[c.key] !== undefined}
                        disabled={workspaceUnavailable}
                        onChange={(v) => useSettings.getState().setDraft(c.key, v)}
                        onReset={() => useSettings.getState().setDraft(c.key, undefined)}
                      />
                    ))}
                    {showAppearance && <ThemeRow />}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <Footer dirty={dirty} disabled={workspaceUnavailable} />
      {confirmingClose && <CloseConfirm />}
    </section>
  );
}

// ---- Header (scope toggle, search, JSON toggle) -----------------------------

function Header({
  scope,
  cwd,
  query,
  setQuery,
  searchRef,
  jsonMode,
  setJsonMode,
}: {
  scope: SettingsScope;
  cwd: string | undefined;
  query: string;
  setQuery: (q: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  jsonMode: boolean;
  setJsonMode: (v: boolean) => void;
}) {
  return (
    <div className="flex shrink-0 flex-col" style={{ padding: "var(--space-4) var(--space-6)", background: "var(--color-bg-recessed)", borderBottom: "1px solid var(--color-border-subtle)", gap: "var(--space-3)" }}>
      <div className="flex items-center justify-between gap-[var(--space-4)]">
        <h1 style={{ color: "var(--color-fg-primary)", fontSize: "var(--text-lg)", fontWeight: 600 }}>Settings</h1>
        <div className="flex items-center gap-[var(--space-3)]">
          <ScopeToggle scope={scope} cwd={cwd} />
          <SmallButton label={jsonMode ? "Close JSON editor" : "Edit settings as JSON"} active={jsonMode} onClick={() => setJsonMode(!jsonMode)}>
            {"{ }"}
          </SmallButton>
        </div>
      </div>
      <label className="flex items-center">
        <span className="sr-only">Search settings</span>
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search settings"
          className="w-full"
          style={{ height: "var(--space-7)", padding: "0 var(--space-3)", border: "1px solid var(--color-border-strong)", borderRadius: "var(--radius-md)", background: "var(--color-bg-base)", color: "var(--color-fg-primary)", fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)" }}
        />
      </label>
    </div>
  );
}

function ScopeToggle({ scope, cwd }: { scope: SettingsScope; cwd: string | undefined }) {
  return (
    <div role="group" aria-label="Settings scope" className="flex items-center" style={{ border: "1px solid var(--color-border-strong)", borderRadius: "var(--radius-md)", overflow: "hidden" }}>
      <ScopeButton active={scope === "user"} onClick={() => useSettings.getState().setScope("user")} label="User">
        User
      </ScopeButton>
      <ScopeButton active={scope === "workspace"} onClick={() => useSettings.getState().setScope("workspace")} label={cwd ? `Workspace — ${cwd}` : "Workspace (no folder open)"}>
        Workspace
      </ScopeButton>
    </div>
  );
}

function ScopeButton({ active, onClick, label, children }: { active: boolean; onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={label}
      className="cursor-pointer transition-colors"
      style={{ padding: "var(--space-2) var(--space-4)", border: "none", background: active ? "var(--color-accent-quiet)" : "transparent", color: active ? "var(--color-fg-primary)" : "var(--color-fg-muted)", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", transitionDuration: "var(--motion-fast)" }}
    >
      {children}
    </button>
  );
}

function SmallButton({ children, label, active, onClick }: { children: ReactNode; label: string; active?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className="flex cursor-pointer items-center justify-center transition-colors"
      style={{ width: "var(--space-7)", height: "var(--space-7)", border: "1px solid var(--color-border-strong)", borderRadius: "var(--radius-md)", background: active ? "var(--color-accent-quiet)" : "transparent", color: active ? "var(--color-fg-primary)" : "var(--color-fg-secondary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", transitionDuration: "var(--motion-fast)" }}
    >
      <span aria-hidden="true">{children}</span>
    </button>
  );
}

// ---- Category rail ----------------------------------------------------------

function CategoryRail({ active, onPick }: { active: Category; onPick: (c: Category) => void }) {
  return (
    <nav aria-label="Settings categories" className="shrink-0 overflow-auto" style={{ width: "200px", padding: "var(--space-4) var(--space-2)", borderRight: "1px solid var(--color-border-subtle)", background: "var(--color-bg-recessed)" }}>
      {CATEGORIES.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => onPick(c.id)}
          aria-current={active === c.id}
          className="flex w-full cursor-pointer items-center transition-colors"
          style={{ padding: "var(--space-2) var(--space-3)", border: "none", borderRadius: "var(--radius-sm)", background: active === c.id ? "var(--color-accent-quiet)" : "transparent", color: active === c.id ? "var(--color-fg-primary)" : "var(--color-fg-secondary)", fontFamily: "var(--font-sans)", fontSize: "var(--text-sm)", textAlign: "left", transitionDuration: "var(--motion-fast)" }}
        >
          {c.label}
        </button>
      ))}
    </nav>
  );
}

// ---- One control row --------------------------------------------------------

function ControlRow({
  def,
  value,
  isSet,
  disabled,
  onChange,
  onReset,
}: {
  def: ControlDef;
  value: NonNullable<EditorSettings[keyof EditorSettings]>;
  isSet: boolean;
  disabled: boolean;
  onChange: (v: EditorSettings[keyof EditorSettings] | undefined) => void;
  onReset: () => void;
}) {
  const id = `setting-${def.key}`;
  return (
    <div
      className="flex items-start justify-between gap-[var(--space-5)] transition-colors hover:bg-[var(--color-bg-raised)]"
      style={{ padding: "var(--space-4) var(--space-3)", borderBottom: "1px solid var(--color-border-subtle)", borderRadius: "var(--radius-sm)", opacity: disabled ? 0.6 : 1, transitionDuration: "var(--motion-fast)" }}
    >
      <div className="min-w-0">
        <label htmlFor={id} className="flex items-center gap-[var(--space-2)]" style={{ color: "var(--color-fg-primary)", fontSize: "var(--text-sm)", fontWeight: 600 }}>
          {def.label}
          {isSet && <span title="Overridden in this scope" aria-label="Overridden in this scope" style={{ width: "6px", height: "6px", borderRadius: "50%", background: "var(--color-accent)" }} />}
        </label>
        <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)", marginTop: "var(--space-1)" }}>{def.description}</p>
        {isSet && !disabled && (
          <button type="button" onClick={onReset} className="cursor-pointer" style={{ marginTop: "var(--space-2)", border: "none", background: "transparent", padding: 0, color: "var(--color-accent)", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}>
            Reset to default
          </button>
        )}
      </div>
      <div className="shrink-0">
        <ControlInput id={id} def={def} value={value} disabled={disabled} onChange={onChange} />
      </div>
    </div>
  );
}

function ControlInput({
  id,
  def,
  value,
  disabled,
  onChange,
}: {
  id: string;
  def: ControlDef;
  value: NonNullable<EditorSettings[keyof EditorSettings]>;
  disabled: boolean;
  onChange: (v: EditorSettings[keyof EditorSettings] | undefined) => void;
}) {
  const fieldStyle = {
    height: "var(--space-7)",
    padding: "0 var(--space-3)",
    border: "1px solid var(--color-border-strong)",
    borderRadius: "var(--radius-sm)",
    background: "var(--color-bg-base)",
    color: "var(--color-fg-primary)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
  } as const;

  if (def.kind === "boolean") {
    return <input id={id} type="checkbox" checked={!!value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ width: "18px", height: "18px", accentColor: "var(--color-accent)", cursor: disabled ? "default" : "pointer" }} />;
  }
  if (def.kind === "select") {
    return (
      <select id={id} value={String(value)} disabled={disabled} onChange={(e) => onChange(e.target.value as WordWrap)} className={disabled ? undefined : "cursor-pointer"} style={{ ...fieldStyle, width: "160px" }}>
        {def.options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (def.kind === "number") {
    return (
      <input
        id={id}
        type="number"
        min={def.min}
        max={def.max}
        value={Number(value)}
        disabled={disabled}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") return; // ignore the empty intermediate state; Reset clears
          const n = Number.parseInt(raw, 10);
          if (Number.isFinite(n)) onChange(n);
        }}
        style={{ ...fieldStyle, width: "96px" }}
      />
    );
  }
  // text (fontFamily): empty input clears the override.
  return (
    <input
      id={id}
      type="text"
      value={String(value === EDITOR_DEFAULTS.fontFamily ? "" : value)}
      placeholder="var(--font-mono)"
      disabled={disabled}
      onChange={(e) => onChange(e.target.value.trim() === "" ? undefined : e.target.value)}
      style={{ ...fieldStyle, width: "240px" }}
    />
  );
}

// ---- Theme (an app-global appearance setting, via the theme store) ----------

function ThemeRow() {
  return (
    <div className="flex items-center justify-between gap-[var(--space-5)] transition-colors hover:bg-[var(--color-bg-raised)]" style={{ padding: "var(--space-4) var(--space-3)", borderBottom: "1px solid var(--color-border-subtle)", borderRadius: "var(--radius-sm)", transitionDuration: "var(--motion-fast)" }}>
      <div className="min-w-0">
        <p style={{ color: "var(--color-fg-primary)", fontSize: "var(--text-sm)", fontWeight: 600 }}>Color Theme</p>
        <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)", marginTop: "var(--space-1)" }}>The app palette. Applies globally and instantly (not part of Apply).</p>
      </div>
      <ThemePicker />
    </div>
  );
}

// ---- Apply / Discard footer -------------------------------------------------

function Footer({ dirty, disabled }: { dirty: boolean; disabled: boolean }) {
  return (
    <div className="flex shrink-0 items-center justify-end gap-[var(--space-4)]" style={{ padding: "var(--space-3) var(--space-6)", background: "var(--color-bg-recessed)", borderTop: "1px solid var(--color-border-subtle)" }}>
      <span style={{ marginRight: "auto", color: dirty ? "var(--color-status-awaiting)" : "var(--color-fg-muted)", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}>
        {dirty ? "Unapplied changes" : "All changes applied"}
      </span>
      <Button onClick={() => useSettings.getState().discard()} disabled={!dirty}>
        Discard
      </Button>
      <Button primary onClick={() => void useSettings.getState().apply()} disabled={!dirty || disabled}>
        Apply
      </Button>
    </div>
  );
}

function Button({ children, primary, disabled, onClick }: { children: ReactNode; primary?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={disabled ? undefined : "cursor-pointer transition-colors"}
      style={{
        padding: "var(--space-2) var(--space-5)",
        borderRadius: "var(--radius-md)",
        border: `1px solid ${primary ? "var(--color-accent)" : "var(--color-border-strong)"}`,
        background: primary ? "var(--color-accent)" : "transparent",
        color: primary ? "var(--color-bg-base)" : "var(--color-fg-primary)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-sm)",
        fontWeight: 500,
        opacity: disabled ? 0.5 : 1,
        transitionDuration: "var(--motion-fast)",
      }}
    >
      {children}
    </button>
  );
}

// ---- Close confirmation (unapplied changes) ---------------------------------

function CloseConfirm() {
  return (
    <div className="absolute inset-0 flex items-center justify-center" role="alertdialog" aria-modal="true" aria-label="Unapplied changes" style={{ background: "rgba(0,0,0,0.45)", zIndex: 20 }}>
      <div style={{ width: "min(440px, 90%)", padding: "var(--space-6)", borderRadius: "var(--radius-lg)", background: "var(--color-bg-overlay)", boxShadow: "var(--elev-3)" }}>
        <p style={{ color: "var(--color-fg-primary)", fontSize: "var(--text-md)", fontWeight: 600 }}>You didn't apply your changes</p>
        <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-sm)", marginTop: "var(--space-3)" }}>
          You have unapplied settings changes. They won't take effect unless you apply them. Close anyway?
        </p>
        <div className="flex justify-end gap-[var(--space-3)]" style={{ marginTop: "var(--space-5)" }}>
          <Button onClick={() => useSettings.getState().cancelClose()}>Keep editing</Button>
          <Button onClick={() => useSettings.getState().discardAndClose()}>Discard &amp; close</Button>
          <Button primary onClick={() => void useSettings.getState().applyAndClose()}>
            Apply &amp; close
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---- Edit as JSON (stages into the draft) -----------------------------------

function JsonEditor({ editor, onDone }: { editor: EditorSettings; onDone: () => void }) {
  const [text, setText] = useState(() => JSON.stringify(editor, null, 2));
  const [error, setError] = useState<string | null>(null);

  const update = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid JSON");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setError("Settings must be a JSON object.");
      return;
    }
    const src = parsed as Record<string, unknown>;
    const next: EditorSettings = {};
    for (const k of EDITOR_KEYS) {
      if (src[k] !== undefined && src[k] !== null) (next as Record<string, unknown>)[k] = src[k];
    }
    setError(null);
    useSettings.getState().replaceDraft(next);
    onDone();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ padding: "var(--space-6)", gap: "var(--space-3)" }}>
      <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)" }}>
        Editing the staged editor block as JSON. Unknown keys are ignored; “Update draft” stages it — then Apply to save.
      </p>
      {error && <Banner tone="error" text={error} />}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        aria-label="Settings JSON"
        className="min-h-0 flex-1"
        style={{ resize: "none", padding: "var(--space-3)", border: "1px solid var(--color-border-strong)", borderRadius: "var(--radius-md)", background: "var(--color-bg-recessed)", color: "var(--color-fg-primary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", lineHeight: "var(--text-sm--line-height)" }}
      />
      <div className="flex justify-end gap-[var(--space-3)]">
        <Button onClick={onDone}>Cancel</Button>
        <Button primary onClick={update}>
          Update draft
        </Button>
      </div>
    </div>
  );
}

// ---- Small shared bits ------------------------------------------------------

function Banner({ text, tone }: { text: string; tone?: "error" }) {
  return (
    <div role={tone === "error" ? "alert" : undefined} className="shrink-0" style={{ padding: "var(--space-2) var(--space-6)", background: "var(--color-bg-recessed)", borderBottom: "1px solid var(--color-border-subtle)", color: tone === "error" ? "var(--color-status-danger)" : "var(--color-fg-secondary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}>
      {text}
    </div>
  );
}

function Note({ text }: { text: string }) {
  return (
    <div style={{ marginBottom: "var(--space-4)", padding: "var(--space-3) var(--space-4)", borderRadius: "var(--radius-md)", background: "var(--color-accent-quiet)", color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)", maxWidth: "720px" }}>
      {text}
    </div>
  );
}
