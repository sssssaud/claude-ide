/*
 * Settings view (Addendum II §1, S1). A full-area, VS Code-style settings
 * surface that opens over the workspace (see `layout.settingsOpen`). A left rail
 * of categories, a searchable list of controls on the right, and a User/Workspace
 * scope toggle — each control edits the active scope and persists immediately
 * through the backend (which validates + clamps). An "Edit as JSON" mode exposes
 * the active scope's raw block for power edits. The settings are the IDE's own
 * preferences (app config dir), never the `claude` CLI's `.claude/settings.json`.
 *
 * Every value is data: numbers are bounded by the inputs (and clamped server-side),
 * the wrap mode is a fixed allow-list, and a bad JSON edit is refused, not run.
 * Tokens only, keyboard-operable, and the three states (loading/error + a saveError
 * banner) are all present.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { ThemePicker } from "@/layout/ThemePicker";
import type { EditorSettings, SettingsScope, WordWrap } from "@/ipc/types";
import { useLayout } from "@/store/layout";
import { EDITOR_DEFAULTS, useSettings } from "@/store/settings";
import { useActiveCwd } from "@/store/workspaces";

type Category = "editor" | "appearance";

const CATEGORIES: { id: Category; label: string }[] = [
  { id: "editor", label: "Text Editor" },
  { id: "appearance", label: "Appearance" },
];

/** The editor controls, declared as data so search + rendering stay uniform. */
interface ControlDef {
  key: keyof EditorSettings;
  label: string;
  description: string;
  /** Extra search terms beyond the label/description. */
  keywords: string;
  kind: "text" | "number" | "boolean" | "select";
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
}

const EDITOR_CONTROLS: ControlDef[] = [
  {
    key: "fontFamily",
    label: "Font Family",
    description: "Controls the editor font. Leave empty to use the app's mono font.",
    keywords: "typeface mono",
    kind: "text",
  },
  {
    key: "fontSize",
    label: "Font Size",
    description: "Editor font size in pixels.",
    keywords: "zoom text size",
    kind: "number",
    min: 6,
    max: 72,
  },
  {
    key: "fontLigatures",
    label: "Font Ligatures",
    description: "Enable programming ligatures (requires a font that has them).",
    keywords: "ligature",
    kind: "boolean",
  },
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
  {
    key: "wordWrapColumn",
    label: "Word Wrap Column",
    description: "The column to wrap at, for the “At column” and “Bounded” modes.",
    keywords: "wrap column ruler",
    kind: "number",
    min: 20,
    max: 400,
  },
  {
    key: "tabSize",
    label: "Tab Size",
    description: "The number of spaces a tab is equal to.",
    keywords: "indent indentation tab",
    kind: "number",
    min: 1,
    max: 16,
  },
  {
    key: "insertSpaces",
    label: "Insert Spaces",
    description: "Insert spaces when pressing Tab.",
    keywords: "indent spaces tab",
    kind: "boolean",
  },
  {
    key: "minimap",
    label: "Minimap",
    description: "Show the code overview minimap on the right edge.",
    keywords: "overview map",
    kind: "boolean",
  },
];

export function SettingsView() {
  const close = useLayout((s) => s.closeSettings);
  const loaded = useSettings((s) => s.loaded);
  const loadError = useSettings((s) => s.loadError);
  const saveError = useSettings((s) => s.saveError);
  const scope = useSettings((s) => s.scope);
  const setScope = useSettings((s) => s.setScope);
  const user = useSettings((s) => s.user);
  const workspaces = useSettings((s) => s.workspaces);
  const cwd = useActiveCwd();

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category>("editor");
  const [jsonMode, setJsonMode] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Load the document the first time the view opens; focus search for the gate.
  useEffect(() => {
    if (!useSettings.getState().loaded) void useSettings.getState().load();
    searchRef.current?.focus();
  }, []);

  // Escape closes the view (it's a full-area overlay, so this is expected).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !jsonMode) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, jsonMode]);

  // The active scope's raw partial (an absent field = "not overridden here").
  const rawScope: EditorSettings = scope === "user" ? user : cwd ? workspaces[cwd] ?? {} : {};
  const workspaceUnavailable = scope === "workspace" && !cwd;

  // What a control shows when this scope hasn't set it: the User value (for the
  // workspace scope) or the built-in default, so the input always reflects reality.
  const fallback = <K extends keyof EditorSettings>(key: K): NonNullable<EditorSettings[K]> => {
    if (scope === "workspace" && user[key] !== undefined && user[key] !== null) {
      return user[key] as NonNullable<EditorSettings[K]>;
    }
    return EDITOR_DEFAULTS[key] as unknown as NonNullable<EditorSettings[K]>;
  };

  const q = query.trim().toLowerCase();
  const matches = (c: ControlDef) =>
    !q ||
    c.label.toLowerCase().includes(q) ||
    c.description.toLowerCase().includes(q) ||
    c.keywords.toLowerCase().includes(q);

  const themeMatches = !q || "theme appearance color palette dark light".includes(q);
  const visibleEditor = useMemo(
    () => (q ? EDITOR_CONTROLS.filter(matches) : category === "editor" ? EDITOR_CONTROLS : []),
    [q, category],
  );
  const showAppearance = q ? themeMatches : category === "appearance";
  const nothingFound = !!q && visibleEditor.length === 0 && !themeMatches;

  return (
    <section
      aria-label="Settings"
      className="flex h-full w-full flex-col"
      style={{ background: "var(--color-bg-base)" }}
    >
      <Header
        scope={scope}
        setScope={setScope}
        cwd={cwd}
        query={query}
        setQuery={setQuery}
        searchRef={searchRef}
        jsonMode={jsonMode}
        setJsonMode={setJsonMode}
        onClose={close}
      />

      {saveError && <Banner tone="error" text={saveError} />}

      {!loaded ? (
        <LoadingState label="Loading settings…" />
      ) : loadError ? (
        <ErrorState
          title="Couldn't load settings"
          error={{ kind: "internal", message: loadError }}
          onRetry={() => void useSettings.getState().load()}
        />
      ) : jsonMode ? (
        <JsonEditor scope={scope} editor={rawScope} cwd={cwd} onDone={() => setJsonMode(false)} />
      ) : (
        <div className="flex min-h-0 flex-1">
          {!q && (
            <CategoryRail active={category} onPick={setCategory} />
          )}
          <div className="min-h-0 flex-1 overflow-auto" style={{ padding: "var(--space-6)" }}>
            {workspaceUnavailable && (
              <Note text="Open a folder to set Workspace-scoped settings. Showing defaults; edits are disabled." />
            )}
            {nothingFound ? (
              <EmptyState title="No matching settings" hint={`Nothing matches “${query.trim()}”.`} />
            ) : (
              <div className="flex flex-col" style={{ gap: "var(--space-2)", maxWidth: "720px" }}>
                {visibleEditor.map((c) => (
                  <ControlRow
                    key={c.key}
                    def={c}
                    value={rawScope[c.key] ?? fallback(c.key)}
                    isSet={rawScope[c.key] !== undefined}
                    disabled={workspaceUnavailable}
                    onChange={(v) => void useSettings.getState().setEditor(scope, c.key, v, cwd)}
                    onReset={() => void useSettings.getState().setEditor(scope, c.key, undefined, cwd)}
                  />
                ))}
                {showAppearance && <ThemeRow />}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// ---- Header (scope toggle, search, JSON toggle, close) ----------------------

function Header({
  scope,
  setScope,
  cwd,
  query,
  setQuery,
  searchRef,
  jsonMode,
  setJsonMode,
  onClose,
}: {
  scope: SettingsScope;
  setScope: (s: SettingsScope) => void;
  cwd: string | undefined;
  query: string;
  setQuery: (q: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  jsonMode: boolean;
  setJsonMode: (v: boolean) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="flex shrink-0 flex-col"
      style={{
        padding: "var(--space-4) var(--space-6)",
        background: "var(--color-bg-recessed)",
        borderBottom: "1px solid var(--color-border-subtle)",
        gap: "var(--space-3)",
      }}
    >
      <div className="flex items-center justify-between gap-[var(--space-4)]">
        <h1 style={{ color: "var(--color-fg-primary)", fontSize: "var(--text-lg)", fontWeight: 600 }}>
          Settings
        </h1>
        <div className="flex items-center gap-[var(--space-3)]">
          <ScopeToggle scope={scope} setScope={setScope} cwd={cwd} />
          <SmallButton
            label={jsonMode ? "Close JSON editor" : "Edit settings as JSON"}
            active={jsonMode}
            onClick={() => setJsonMode(!jsonMode)}
          >
            {"{ }"}
          </SmallButton>
          <SmallButton label="Close settings (Esc)" onClick={onClose}>
            ✕
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
          style={{
            height: "var(--space-7)",
            padding: "0 var(--space-3)",
            border: "1px solid var(--color-border-strong)",
            borderRadius: "var(--radius-md)",
            background: "var(--color-bg-base)",
            color: "var(--color-fg-primary)",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-sm)",
          }}
        />
      </label>
    </div>
  );
}

function ScopeToggle({
  scope,
  setScope,
  cwd,
}: {
  scope: SettingsScope;
  setScope: (s: SettingsScope) => void;
  cwd: string | undefined;
}) {
  return (
    <div
      role="group"
      aria-label="Settings scope"
      className="flex items-center"
      style={{
        border: "1px solid var(--color-border-strong)",
        borderRadius: "var(--radius-md)",
        overflow: "hidden",
      }}
    >
      <ScopeButton active={scope === "user"} onClick={() => setScope("user")} label="User">
        User
      </ScopeButton>
      <ScopeButton
        active={scope === "workspace"}
        onClick={() => setScope("workspace")}
        label={cwd ? `Workspace — ${cwd}` : "Workspace (no folder open)"}
      >
        Workspace
      </ScopeButton>
    </div>
  );
}

function ScopeButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={label}
      className="cursor-pointer transition-colors"
      style={{
        padding: "var(--space-2) var(--space-4)",
        border: "none",
        background: active ? "var(--color-accent-quiet)" : "transparent",
        color: active ? "var(--color-fg-primary)" : "var(--color-fg-muted)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        transitionDuration: "var(--motion-fast)",
      }}
    >
      {children}
    </button>
  );
}

function SmallButton({
  children,
  label,
  active,
  onClick,
}: {
  children: ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className="flex cursor-pointer items-center justify-center transition-colors"
      style={{
        width: "var(--space-7)",
        height: "var(--space-7)",
        border: "1px solid var(--color-border-strong)",
        borderRadius: "var(--radius-md)",
        background: active ? "var(--color-accent-quiet)" : "transparent",
        color: active ? "var(--color-fg-primary)" : "var(--color-fg-secondary)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        transitionDuration: "var(--motion-fast)",
      }}
    >
      <span aria-hidden="true">{children}</span>
    </button>
  );
}

// ---- Category rail ----------------------------------------------------------

function CategoryRail({ active, onPick }: { active: Category; onPick: (c: Category) => void }) {
  return (
    <nav
      aria-label="Settings categories"
      className="shrink-0 overflow-auto"
      style={{
        width: "200px",
        padding: "var(--space-4) var(--space-2)",
        borderRight: "1px solid var(--color-border-subtle)",
        background: "var(--color-bg-recessed)",
      }}
    >
      {CATEGORIES.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => onPick(c.id)}
          aria-current={active === c.id}
          className="flex w-full cursor-pointer items-center transition-colors"
          style={{
            padding: "var(--space-2) var(--space-3)",
            border: "none",
            borderRadius: "var(--radius-sm)",
            background: active === c.id ? "var(--color-accent-quiet)" : "transparent",
            color: active === c.id ? "var(--color-fg-primary)" : "var(--color-fg-secondary)",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-sm)",
            textAlign: "left",
            transitionDuration: "var(--motion-fast)",
          }}
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
      className="flex items-start justify-between gap-[var(--space-5)]"
      style={{
        padding: "var(--space-4)",
        borderRadius: "var(--radius-md)",
        background: "var(--color-bg-raised)",
        border: "1px solid var(--color-border-subtle)",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <div className="min-w-0">
        <label
          htmlFor={id}
          className="flex items-center gap-[var(--space-2)]"
          style={{ color: "var(--color-fg-primary)", fontSize: "var(--text-sm)", fontWeight: 600 }}
        >
          {def.label}
          {isSet && (
            <span
              title="Overridden in this scope"
              aria-label="Overridden in this scope"
              style={{
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                background: "var(--color-accent)",
              }}
            />
          )}
        </label>
        <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)", marginTop: "var(--space-1)" }}>
          {def.description}
        </p>
        {isSet && !disabled && (
          <button
            type="button"
            onClick={onReset}
            className="cursor-pointer"
            style={{
              marginTop: "var(--space-2)",
              border: "none",
              background: "transparent",
              padding: 0,
              color: "var(--color-accent)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
            }}
          >
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
    return (
      <input
        id={id}
        type="checkbox"
        checked={!!value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: "18px", height: "18px", accentColor: "var(--color-accent)", cursor: disabled ? "default" : "pointer" }}
      />
    );
  }
  if (def.kind === "select") {
    return (
      <select
        id={id}
        value={String(value)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as WordWrap)}
        className={disabled ? undefined : "cursor-pointer"}
        style={{ ...fieldStyle, width: "160px" }}
      >
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
          if (raw === "") return; // ignore empty intermediate state; Reset clears
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
      onChange={(e) => {
        const v = e.target.value;
        onChange(v.trim() === "" ? undefined : v);
      }}
      style={{ ...fieldStyle, width: "240px" }}
    />
  );
}

// ---- Theme (an app-global appearance setting, via the theme store) ----------

function ThemeRow() {
  return (
    <div
      className="flex items-center justify-between gap-[var(--space-5)]"
      style={{
        padding: "var(--space-4)",
        borderRadius: "var(--radius-md)",
        background: "var(--color-bg-raised)",
        border: "1px solid var(--color-border-subtle)",
      }}
    >
      <div className="min-w-0">
        <p style={{ color: "var(--color-fg-primary)", fontSize: "var(--text-sm)", fontWeight: 600 }}>
          Color Theme
        </p>
        <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)", marginTop: "var(--space-1)" }}>
          The app palette. Applies globally and persists across restarts.
        </p>
      </div>
      <ThemePicker />
    </div>
  );
}

// ---- Edit as JSON -----------------------------------------------------------

function JsonEditor({
  scope,
  editor,
  cwd,
  onDone,
}: {
  scope: SettingsScope;
  editor: EditorSettings;
  cwd: string | undefined;
  onDone: () => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(editor, null, 2));
  const [error, setError] = useState<string | null>(null);

  const apply = async () => {
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
    // Keep only the keys we model; the backend validates + clamps the values.
    const src = parsed as Record<string, unknown>;
    const next: EditorSettings = {};
    const keys: (keyof EditorSettings)[] = [
      "fontFamily",
      "fontSize",
      "fontLigatures",
      "wordWrap",
      "wordWrapColumn",
      "tabSize",
      "insertSpaces",
      "minimap",
    ];
    for (const k of keys) {
      if (src[k] !== undefined && src[k] !== null) (next as Record<string, unknown>)[k] = src[k];
    }
    setError(null);
    await useSettings.getState().replaceEditor(scope, next, cwd);
    onDone();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ padding: "var(--space-6)", gap: "var(--space-3)" }}>
      <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)" }}>
        Editing the <strong style={{ color: "var(--color-fg-primary)" }}>{scope}</strong> scope's editor
        block as JSON. Unknown keys are ignored; values are validated on save.
      </p>
      {error && <Banner tone="error" text={error} />}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        aria-label="Settings JSON"
        className="min-h-0 flex-1"
        style={{
          resize: "none",
          padding: "var(--space-3)",
          border: "1px solid var(--color-border-strong)",
          borderRadius: "var(--radius-md)",
          background: "var(--color-bg-recessed)",
          color: "var(--color-fg-primary)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-sm)",
          lineHeight: "var(--text-sm--line-height)",
        }}
      />
      <div className="flex justify-end gap-[var(--space-3)]">
        <GhostButton onClick={onDone}>Cancel</GhostButton>
        <GhostButton primary onClick={() => void apply()}>
          Apply
        </GhostButton>
      </div>
    </div>
  );
}

function GhostButton({
  children,
  primary,
  onClick,
}: {
  children: ReactNode;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer transition-colors"
      style={{
        padding: "var(--space-2) var(--space-5)",
        borderRadius: "var(--radius-md)",
        border: `1px solid ${primary ? "var(--color-accent)" : "var(--color-border-strong)"}`,
        background: primary ? "var(--color-accent)" : "transparent",
        color: primary ? "var(--color-bg-base)" : "var(--color-fg-primary)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-sm)",
        fontWeight: 500,
        transitionDuration: "var(--motion-fast)",
      }}
    >
      {children}
    </button>
  );
}

// ---- Small shared bits ------------------------------------------------------

function Banner({ text, tone }: { text: string; tone?: "error" }) {
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className="shrink-0"
      style={{
        padding: "var(--space-2) var(--space-6)",
        background: "var(--color-bg-recessed)",
        borderBottom: "1px solid var(--color-border-subtle)",
        color: tone === "error" ? "var(--color-status-danger)" : "var(--color-fg-secondary)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
      }}
    >
      {text}
    </div>
  );
}

function Note({ text }: { text: string }) {
  return (
    <div
      style={{
        marginBottom: "var(--space-4)",
        padding: "var(--space-3) var(--space-4)",
        borderRadius: "var(--radius-md)",
        background: "var(--color-accent-quiet)",
        color: "var(--color-fg-secondary)",
        fontSize: "var(--text-xs)",
        maxWidth: "720px",
      }}
    >
      {text}
    </div>
  );
}
