/*
 * Settings view (Addendum II §1 + staged-apply revision; widened to every
 * category in S6). Opens as a closable EDITOR TAB (see `editor.openSettings`),
 * VS Code-style. A left rail of categories, a searchable list of controls, and
 * a User/Workspace scope toggle.
 *
 * Editing is STAGED: controls edit a draft (in the settings store); nothing
 * changes in the editor/terminal/explorer until you hit Apply. Closing the tab
 * with unapplied changes prompts first. Everything is data — numbers are
 * bounded by the inputs (and clamped server-side), selects are a fixed
 * allow-list, and a bad JSON edit is refused, not run. Keybindings (its own
 * category) are the one exception: they save immediately, VS Code-style — see
 * `KeybindingsSection`. Tokens only, keyboard-operable, three states present.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { InlineTerminal } from "@/components/InlineTerminal";
import { KeybindingsSection } from "@/layout/KeybindingsSection";
import { PermissionsPanel } from "@/layout/PermissionsPanel";
import { ThemePicker } from "@/layout/ThemePicker";
import { listAvailablePlugins, listMarketplaces, listMcpServers, listPlugins, tokenClear, tokenSet, tokensStatus } from "@/ipc/commands";
import type { AvailablePlugin, MarketplaceEntry, McpServerEntry, PluginEntry, ScopeSettings, SettingsScope, TokenProvider, TokenStatus } from "@/ipc/types";
import { isIpcError } from "@/ipc/types";
import { shellQuote } from "@/lib/shell";
import { useAuth } from "@/store/auth";
import {
  APPEARANCE_DEFAULTS,
  EDITOR_DEFAULTS,
  FILES_DEFAULTS,
  TERMINAL_DEFAULTS,
  sanitizeScopeSettings,
  useSettings,
} from "@/store/settings";
import { useActiveCwd } from "@/store/workspaces";

type Category = "editor" | "files" | "terminal" | "appearance" | "keybindings" | "account" | "tokens" | "permissions" | "plugins" | "mcp";
type SettingsCategory = keyof ScopeSettings;

const CATEGORIES: { id: Category; label: string }[] = [
  { id: "editor", label: "Text Editor" },
  { id: "files", label: "Files" },
  { id: "terminal", label: "Terminal" },
  { id: "appearance", label: "Appearance" },
  { id: "keybindings", label: "Keybindings" },
  { id: "account", label: "Account" },
  { id: "tokens", label: "API Tokens" },
  { id: "permissions", label: "Permissions" },
  { id: "plugins", label: "Plugins & Skills" },
  { id: "mcp", label: "MCP Servers" },
];

/** Categories that render a self-contained section with its own actions/save,
 *  rather than the generic staged-apply control-list — Account, Permissions,
 *  Plugins & Skills, MCP Servers. They skip the generic heading and the
 *  staged-apply footer. (Permissions is workspace-scoped and Account/Plugins/
 *  MCP are user-global, but all four own their own save path.) */
const ACTION_CATEGORIES: Category[] = ["account", "tokens", "permissions", "plugins", "mcp"];

/** Which backend sub-object each control's default lives in, for the "unset"
 *  fallback and the text control's clear-to-placeholder behaviour. Untyped as
 *  `Record<string, unknown>` since one map spans four differently-shaped
 *  structs (`exclude` is a `string[]`, handled by its own `ExcludeControl`,
 *  never through this generic path). */
const DEFAULTS_BY_CATEGORY: Record<SettingsCategory, Record<string, unknown>> = {
  editor: EDITOR_DEFAULTS as unknown as Record<string, unknown>,
  terminal: TERMINAL_DEFAULTS as unknown as Record<string, unknown>,
  files: FILES_DEFAULTS as unknown as Record<string, unknown>,
  appearance: APPEARANCE_DEFAULTS as unknown as Record<string, unknown>,
};

type FieldValue = string | number | boolean;

interface ControlDef {
  dataCategory: SettingsCategory;
  key: string;
  label: string;
  description: string;
  keywords: string;
  kind: "text" | "number" | "boolean" | "select";
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
}

/** Stage one control's value. `ControlDef.key` is intentionally a loose
 *  `string` (one array mixes fields from differently-shaped category structs);
 *  `setDraft` itself stays strongly typed everywhere else it's called. */
function setControlDraft(category: SettingsCategory, key: string, value: FieldValue | undefined) {
  (useSettings.getState().setDraft as (c: SettingsCategory, k: string, v: unknown) => void)(
    category,
    key,
    value,
  );
}

const EDITOR_CONTROLS: ControlDef[] = [
  { dataCategory: "editor", key: "fontFamily", label: "Font Family", description: "Controls the editor font. Leave empty to use the app's mono font.", keywords: "typeface mono", kind: "text" },
  { dataCategory: "editor", key: "fontSize", label: "Font Size", description: "Editor font size in pixels.", keywords: "zoom text size", kind: "number", min: 6, max: 72 },
  { dataCategory: "editor", key: "fontLigatures", label: "Font Ligatures", description: "Enable programming ligatures (requires a font that has them).", keywords: "ligature", kind: "boolean" },
  {
    dataCategory: "editor",
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
  { dataCategory: "editor", key: "wordWrapColumn", label: "Word Wrap Column", description: "The column to wrap at, for the “At column” and “Bounded” modes.", keywords: "wrap column ruler", kind: "number", min: 20, max: 400 },
  { dataCategory: "editor", key: "tabSize", label: "Tab Size", description: "The number of spaces a tab is equal to.", keywords: "indent indentation tab", kind: "number", min: 1, max: 16 },
  { dataCategory: "editor", key: "insertSpaces", label: "Insert Spaces", description: "Insert spaces when pressing Tab.", keywords: "indent spaces tab", kind: "boolean" },
  { dataCategory: "editor", key: "minimap", label: "Minimap", description: "Show the code overview minimap on the right edge.", keywords: "overview map", kind: "boolean" },
  { dataCategory: "editor", key: "formatOnSave", label: "Format On Save", description: "Run the language's formatter (if one is registered — JSON, CSS, HTML, TypeScript, and the like) when you save.", keywords: "format prettier save", kind: "boolean" },
  { dataCategory: "editor", key: "formatOnPaste", label: "Format On Paste", description: "Run the language's formatter (if one is registered) on text you paste in.", keywords: "format paste", kind: "boolean" },
];

const FILES_CONTROLS: ControlDef[] = [
  {
    dataCategory: "editor",
    key: "autoSave",
    label: "Auto Save",
    description: "When to save edited files automatically.",
    keywords: "autosave save files",
    kind: "select",
    options: [
      { value: "off", label: "Off" },
      { value: "afterDelay", label: "After a delay" },
      { value: "onFocusChange", label: "On focus change" },
      { value: "onWindowChange", label: "On window change" },
    ],
  },
  { dataCategory: "editor", key: "autoSaveDelay", label: "Auto Save Delay", description: "Delay in milliseconds before saving, when Auto Save is “After a delay”.", keywords: "autosave delay files", kind: "number", min: 200, max: 60000 },
  { dataCategory: "editor", key: "trimTrailingWhitespace", label: "Trim Trailing Whitespace", description: "Strip trailing whitespace on save. Skipped for Markdown, where trailing spaces are a significant line break.", keywords: "whitespace trim files save", kind: "boolean" },
  { dataCategory: "editor", key: "insertFinalNewline", label: "Insert Final Newline", description: "Ensure a file ends with a newline character on save.", keywords: "newline eof files save", kind: "boolean" },
  { dataCategory: "editor", key: "trimFinalNewlines", label: "Trim Final Newlines", description: "Trim extra blank lines at the end of a file on save.", keywords: "newline eof files save", kind: "boolean" },
  {
    dataCategory: "files",
    key: "eol",
    label: "End Of Line",
    description: "Line ending written on save. “Auto” keeps whatever the file already uses.",
    keywords: "eol line ending crlf lf newline",
    kind: "select",
    options: [
      { value: "auto", label: "Auto" },
      { value: "lf", label: "LF" },
      { value: "crlf", label: "CRLF" },
    ],
  },
  { dataCategory: "files", key: "confirmCloseUnsaved", label: "Confirm Before Closing Unsaved Files", description: "Prompt before closing a tab with unsaved changes.", keywords: "confirm close unsaved dirty prompt", kind: "boolean" },
];

const TERMINAL_CONTROLS: ControlDef[] = [
  { dataCategory: "terminal", key: "fontFamily", label: "Font Family", description: "Controls the terminal font. Leave empty to use the app's mono font.", keywords: "typeface mono terminal", kind: "text" },
  { dataCategory: "terminal", key: "fontSize", label: "Font Size", description: "Terminal font size in pixels.", keywords: "zoom text size terminal", kind: "number", min: 6, max: 72 },
  { dataCategory: "terminal", key: "cursorBlink", label: "Cursor Blink", description: "Blink the terminal cursor.", keywords: "cursor blink terminal", kind: "boolean" },
  { dataCategory: "terminal", key: "scrollback", label: "Scrollback", description: "Lines kept in the terminal's scrollback buffer.", keywords: "scrollback history buffer terminal", kind: "number", min: 100, max: 100000 },
];

const APPEARANCE_CONTROLS: ControlDef[] = [
  { dataCategory: "appearance", key: "colorFileIcons", label: "Color File Icons", description: "Tint file-explorer icons by file type.", keywords: "icons color files explorer", kind: "boolean" },
  { dataCategory: "appearance", key: "reducedMotion", label: "Reduce Motion", description: "Force animations and transitions off app-wide, regardless of the OS setting.", keywords: "motion animation accessibility a11y", kind: "boolean" },
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
  const fallback = (dataCategory: SettingsCategory, key: string): FieldValue => {
    if (scope === "workspace") {
      const uv = (user[dataCategory] as Record<string, unknown>)[key];
      if (uv !== undefined && uv !== null) return uv as FieldValue;
    }
    return DEFAULTS_BY_CATEGORY[dataCategory][key] as FieldValue;
  };
  const draftValue = (dataCategory: SettingsCategory, key: string): FieldValue | undefined =>
    (draft[dataCategory] as Record<string, unknown>)[key] as FieldValue | undefined;

  const q = query.trim().toLowerCase();
  const matches = (c: ControlDef) =>
    !q || c.label.toLowerCase().includes(q) || c.description.toLowerCase().includes(q) || c.keywords.toLowerCase().includes(q);
  const themeMatches = !q || "theme appearance color palette dark light".includes(q);
  const excludeMatches = !q || "exclude ignore hide files search explorer".includes(q);
  const visibleEditor = useMemo(
    () => (q ? EDITOR_CONTROLS.filter(matches) : category === "editor" ? EDITOR_CONTROLS : []),
    [q, category],
  );
  const visibleFiles = useMemo(
    () => (q ? FILES_CONTROLS.filter(matches) : category === "files" ? FILES_CONTROLS : []),
    [q, category],
  );
  const visibleTerminal = useMemo(
    () => (q ? TERMINAL_CONTROLS.filter(matches) : category === "terminal" ? TERMINAL_CONTROLS : []),
    [q, category],
  );
  const visibleAppearance = useMemo(
    () => (q ? APPEARANCE_CONTROLS.filter(matches) : category === "appearance" ? APPEARANCE_CONTROLS : []),
    [q, category],
  );
  const showExclude = q ? excludeMatches : category === "files";
  const showAppearance = q ? themeMatches : category === "appearance";
  const nothingFound =
    !!q &&
    visibleEditor.length === 0 &&
    visibleFiles.length === 0 &&
    visibleTerminal.length === 0 &&
    visibleAppearance.length === 0 &&
    !themeMatches &&
    !excludeMatches;

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
        <JsonEditor settings={draft} onDone={() => setJsonMode(false)} />
      ) : (
        <div className="flex min-h-0 flex-1">
          {!q && <CategoryRail active={category} onPick={setCategory} />}
          <div className="min-h-0 flex-1 overflow-auto" style={{ padding: "var(--space-6) var(--space-7)" }}>
            <div style={{ maxWidth: "760px", margin: "0 auto" }}>
              {workspaceUnavailable && category !== "keybindings" && !ACTION_CATEGORIES.includes(category) && (
                <Note text="Open a folder to set Workspace-scoped settings. Showing defaults; edits are disabled." />
              )}
              {nothingFound && category !== "keybindings" ? (
                <EmptyState title="No matching settings" hint={`Nothing matches “${query.trim()}”.`} />
              ) : (
                <>
                  {!q && category !== "keybindings" && !ACTION_CATEGORIES.includes(category) && (
                    <h2 style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "var(--space-3)" }}>
                      {CATEGORIES.find((c) => c.id === category)?.label}
                    </h2>
                  )}
                  <div className="flex flex-col">
                    {visibleEditor.map((c) => (
                      <ControlRow
                        key={`${c.dataCategory}.${c.key}`}
                        def={c}
                        value={draftValue(c.dataCategory, c.key) ?? fallback(c.dataCategory, c.key)}
                        isSet={draftValue(c.dataCategory, c.key) !== undefined}
                        disabled={workspaceUnavailable}
                        onChange={(v) => setControlDraft(c.dataCategory, c.key, v)}
                        onReset={() => setControlDraft(c.dataCategory, c.key, undefined)}
                      />
                    ))}
                    {visibleFiles.map((c) => (
                      <ControlRow
                        key={`${c.dataCategory}.${c.key}`}
                        def={c}
                        value={draftValue(c.dataCategory, c.key) ?? fallback(c.dataCategory, c.key)}
                        isSet={draftValue(c.dataCategory, c.key) !== undefined}
                        disabled={workspaceUnavailable}
                        onChange={(v) => setControlDraft(c.dataCategory, c.key, v)}
                        onReset={() => setControlDraft(c.dataCategory, c.key, undefined)}
                      />
                    ))}
                    {showExclude && <ExcludeControl disabled={workspaceUnavailable} />}
                    {visibleTerminal.map((c) => (
                      <ControlRow
                        key={`${c.dataCategory}.${c.key}`}
                        def={c}
                        value={draftValue(c.dataCategory, c.key) ?? fallback(c.dataCategory, c.key)}
                        isSet={draftValue(c.dataCategory, c.key) !== undefined}
                        disabled={workspaceUnavailable}
                        onChange={(v) => setControlDraft(c.dataCategory, c.key, v)}
                        onReset={() => setControlDraft(c.dataCategory, c.key, undefined)}
                      />
                    ))}
                    {visibleAppearance.map((c) => (
                      <ControlRow
                        key={`${c.dataCategory}.${c.key}`}
                        def={c}
                        value={draftValue(c.dataCategory, c.key) ?? fallback(c.dataCategory, c.key)}
                        isSet={draftValue(c.dataCategory, c.key) !== undefined}
                        disabled={workspaceUnavailable}
                        onChange={(v) => setControlDraft(c.dataCategory, c.key, v)}
                        onReset={() => setControlDraft(c.dataCategory, c.key, undefined)}
                      />
                    ))}
                    {showAppearance && <ThemeRow />}
                  </div>
                  {!q && category === "keybindings" && <KeybindingsSection />}
                  {!q && category === "account" && <AccountSection />}
                  {!q && category === "tokens" && <TokensSection />}
                  {!q && category === "permissions" && <PermissionsPanel />}
                  {!q && category === "plugins" && <PluginsSection />}
                  {!q && category === "mcp" && <McpSection />}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <Footer dirty={dirty} disabled={workspaceUnavailable} hidden={(category === "keybindings" || ACTION_CATEGORIES.includes(category)) && !q} />
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
  value: FieldValue;
  isSet: boolean;
  disabled: boolean;
  onChange: (v: FieldValue | undefined) => void;
  onReset: () => void;
}) {
  const id = `setting-${def.dataCategory}-${def.key}`;
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
  value: FieldValue;
  disabled: boolean;
  onChange: (v: FieldValue | undefined) => void;
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
      <select id={id} value={String(value)} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={disabled ? undefined : "cursor-pointer"} style={{ ...fieldStyle, width: "160px" }}>
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
  const defaultValue = DEFAULTS_BY_CATEGORY[def.dataCategory][def.key];
  return (
    <input
      id={id}
      type="text"
      value={String(value === defaultValue ? "" : value)}
      placeholder="var(--font-mono)"
      disabled={disabled}
      onChange={(e) => onChange(e.target.value.trim() === "" ? undefined : e.target.value)}
      style={{ ...fieldStyle, width: "240px" }}
    />
  );
}

// ---- Files: excluded names (a list, not a scalar — its own control) ---------

function ExcludeControl({ disabled }: { disabled: boolean }) {
  const draftExclude = useSettings((s) => s.draft.files.exclude);
  const scope = useSettings((s) => s.scope);
  const user = useSettings((s) => s.user);
  const isSet = draftExclude !== undefined;
  const applied = scope === "workspace" ? (user.files.exclude ?? FILES_DEFAULTS.exclude) : FILES_DEFAULTS.exclude;
  const value = draftExclude ?? applied;
  const textRef = useRef<HTMLTextAreaElement>(null);

  const commit = () => {
    const raw = textRef.current?.value ?? "";
    const names = raw
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    useSettings.getState().setDraft("files", "exclude", names.length ? names : undefined);
  };

  return (
    <div
      className="flex items-start justify-between gap-[var(--space-5)] transition-colors hover:bg-[var(--color-bg-raised)]"
      style={{ padding: "var(--space-4) var(--space-3)", borderBottom: "1px solid var(--color-border-subtle)", borderRadius: "var(--radius-sm)", opacity: disabled ? 0.6 : 1, transitionDuration: "var(--motion-fast)" }}
    >
      <div className="min-w-0">
        <label htmlFor="setting-files-exclude" className="flex items-center gap-[var(--space-2)]" style={{ color: "var(--color-fg-primary)", fontSize: "var(--text-sm)", fontWeight: 600 }}>
          Exclude
          {isSet && <span title="Overridden in this scope" aria-label="Overridden in this scope" style={{ width: "6px", height: "6px", borderRadius: "50%", background: "var(--color-accent)" }} />}
        </label>
        <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)", marginTop: "var(--space-1)" }}>
          Folder/file names hidden from the explorer, search, and Quick Open — one per line, an exact name match (not a glob).
        </p>
        {isSet && !disabled && (
          <button
            type="button"
            onClick={() => useSettings.getState().setDraft("files", "exclude", undefined)}
            className="cursor-pointer"
            style={{ marginTop: "var(--space-2)", border: "none", background: "transparent", padding: 0, color: "var(--color-accent)", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}
          >
            Reset to default
          </button>
        )}
      </div>
      <textarea
        key={value.join("\n")}
        id="setting-files-exclude"
        ref={textRef}
        defaultValue={value.join("\n")}
        disabled={disabled}
        onBlur={commit}
        rows={4}
        spellCheck={false}
        placeholder={"dist\ncoverage"}
        style={{ width: "220px", resize: "vertical", padding: "var(--space-2) var(--space-3)", border: "1px solid var(--color-border-strong)", borderRadius: "var(--radius-sm)", background: "var(--color-bg-base)", color: "var(--color-fg-primary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}
      />
    </div>
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

// ---- Account (Addendum II §S2.5) --------------------------------------------
// Never hand-rolled: status is read via `claude auth status`, logout via
// `claude auth logout`, and "Log in" hosts the CLI's own interactive
// `claude auth login` in an `InlineTerminal` (browser/OAuth, possibly SSO).

function AccountSection() {
  const status = useAuth((s) => s.status);
  const loaded = useAuth((s) => s.loaded);
  const loadError = useAuth((s) => s.loadError);
  const loggingOut = useAuth((s) => s.loggingOut);
  const logoutError = useAuth((s) => s.logoutError);
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    if (!loaded) void useAuth.getState().refresh();
  }, [loaded]);

  return (
    <div style={{ marginTop: "var(--space-2)", padding: "var(--space-4) var(--space-3)", borderTop: "1px solid var(--color-border-subtle)" }}>
      <p style={{ color: "var(--color-fg-primary)", fontSize: "var(--text-sm)", fontWeight: 600 }}>Claude Account</p>

      {!loaded ? (
        <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)", marginTop: "var(--space-2)" }}>Checking sign-in status…</p>
      ) : loadError ? (
        <div style={{ marginTop: "var(--space-2)" }}>
          <ErrorState title="Couldn't check sign-in status" error={{ kind: "internal", message: loadError }} onRetry={() => void useAuth.getState().refresh()} />
        </div>
      ) : status?.loggedIn ? (
        <>
          <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)", marginTop: "var(--space-2)" }}>
            Signed in as {status.email ?? "unknown"}
            {status.subscriptionType ? ` · ${status.subscriptionType}` : ""}
            {status.authMethod ? ` · ${status.authMethod}` : ""}
          </p>
          {logoutError && <Banner tone="error" text={logoutError} />}
          <div style={{ marginTop: "var(--space-3)" }}>
            <Button onClick={() => void useAuth.getState().logout()} disabled={loggingOut}>
              {loggingOut ? "Signing out…" : "Log out"}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)", marginTop: "var(--space-2)" }}>Not signed in.</p>
          {!signingIn ? (
            <div style={{ marginTop: "var(--space-3)" }}>
              <Button primary onClick={() => setSigningIn(true)}>
                Log in
              </Button>
            </div>
          ) : (
            <div style={{ marginTop: "var(--space-3)" }}>
              <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)", marginBottom: "var(--space-2)" }}>
                Running <code>claude auth login</code> — follow the prompt below (it opens your browser).
              </p>
              <InlineTerminal
                key="settings-login"
                command="claude auth login"
                onExit={() => {
                  setSigningIn(false);
                  void useAuth.getState().refresh();
                }}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---- API Tokens (global GitHub / Hugging Face credentials) ------------------
// One secure store (`tokens.rs`: app-config `tokens.json`, 0600) entered once
// here; injected as standard env vars into every engine session and terminal
// opened afterwards. The secret never comes back over IPC — only a masked tail.

const TOKEN_PROVIDERS: { id: TokenProvider; label: string; hint: string; vars: string }[] = [
  { id: "github", label: "GitHub", hint: "Personal access token (ghp_… or github_pat_…)", vars: "GITHUB_TOKEN, GH_TOKEN" },
  { id: "huggingface", label: "Hugging Face", hint: "Access token (hf_…)", vars: "HF_TOKEN, HUGGING_FACE_HUB_TOKEN" },
];

function TokensSection() {
  const [statuses, setStatuses] = useState<TokenStatus[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<TokenProvider | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    try {
      setStatuses(await tokensStatus());
      setLoadError(null);
    } catch (e) {
      setLoadError(isIpcError(e) ? e.message : "Couldn't read the token store");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (provider: TokenProvider, fn: () => Promise<void>) => {
    setBusy(provider);
    setRowError((r) => ({ ...r, [provider]: "" }));
    try {
      await fn();
      setDrafts((d) => ({ ...d, [provider]: "" }));
      await refresh();
    } catch (e) {
      setRowError((r) => ({ ...r, [provider]: isIpcError(e) ? e.message : "Something went wrong" }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ marginTop: "var(--space-2)", padding: "var(--space-4) var(--space-3)", borderTop: "1px solid var(--color-border-subtle)" }}>
      <p style={{ color: "var(--color-fg-primary)", fontSize: "var(--text-sm)", fontWeight: 600 }}>API Tokens</p>
      <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)", marginTop: "var(--space-2)" }}>
        Enter a token once and every new agent session and terminal gets it automatically as standard
        environment variables. Stored owner-only-readable in the app config folder — never in a project,
        never sent anywhere except the tools that read those variables. A variable already set in your
        shell always wins over the stored token. Applies to sessions and terminals opened after saving.
      </p>

      {loadError ? (
        <div style={{ marginTop: "var(--space-3)" }}>
          <ErrorState title="Couldn't read the token store" error={{ kind: "internal", message: loadError }} onRetry={() => void refresh()} />
        </div>
      ) : !statuses ? (
        <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)", marginTop: "var(--space-2)" }}>Loading…</p>
      ) : (
        TOKEN_PROVIDERS.map((p) => {
          const st = statuses.find((s) => s.provider === p.id);
          const stored = st?.masked ?? null;
          const draft = drafts[p.id] ?? "";
          return (
            <div key={p.id} style={{ marginTop: "var(--space-4)" }}>
              <p style={{ color: "var(--color-fg-primary)", fontSize: "var(--text-sm)" }}>
                {p.label}
                <span style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)", marginLeft: "var(--space-2)" }}>
                  {stored ? `saved (${stored})` : "not set"}
                </span>
              </p>
              <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)", marginTop: "var(--space-1)" }}>
                {p.hint} · fills {p.vars}
              </p>
              {st?.envOverridden && (
                <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)", marginTop: "var(--space-1)" }}>
                  Already set in your environment — the stored token won't override it.
                </p>
              )}
              <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)", alignItems: "center" }}>
                <input
                  type="password"
                  value={draft}
                  onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                  placeholder={stored ? "Replace token…" : "Paste token…"}
                  aria-label={`${p.label} token`}
                  autoComplete="off"
                  spellCheck={false}
                  style={{
                    flex: "0 1 320px",
                    padding: "var(--space-2)",
                    background: "var(--color-bg-base)",
                    color: "var(--color-fg-primary)",
                    border: "1px solid var(--color-border-subtle)",
                    borderRadius: "var(--radius-sm)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-xs)",
                  }}
                />
                <Button primary disabled={busy !== null || !draft.trim()} onClick={() => void act(p.id, () => tokenSet(p.id, draft))}>
                  {busy === p.id ? "Saving…" : "Save"}
                </Button>
                {stored && (
                  <Button disabled={busy !== null} onClick={() => void act(p.id, () => tokenClear(p.id))}>
                    Remove
                  </Button>
                )}
              </div>
              {rowError[p.id] && <Banner tone="error" text={rowError[p.id]} />}
            </div>
          );
        })
      )}
    </div>
  );
}

// ---- Plugins & Skills (Addendum III §S11) -----------------------------------
// Never hand-rolled: read-only status comes from `claude plugin list --json` /
// `marketplace list --json`; every mutating action runs the CLI's own command
// through `InlineTerminal` — the same pattern Account uses for `claude auth
// login` — a real shell, never a second hand-rolled mutation path. Three
// clearly separated blocks (Marketplaces / Plugins / Skills) rather than one
// flat list, so managing either is legible at a glance.

/** `"name@marketplace"` -> the two parts; a skill's id ends in `@skills-dir`. */
function splitPluginId(id: string | null): { name: string; source: string } {
  const s = id ?? "";
  const at = s.lastIndexOf("@");
  return at === -1 ? { name: s, source: "" } : { name: s.slice(0, at), source: s.slice(at + 1) };
}

function PluginsSection() {
  const [plugins, setPlugins] = useState<PluginEntry[] | null>(null);
  const [marketplaces, setMarketplaces] = useState<MarketplaceEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeCommand, setActiveCommand] = useState<string | null>(null);
  const [activeLabel, setActiveLabel] = useState("");

  const load = () => {
    setLoadError(null);
    Promise.all([listPlugins(), listMarketplaces()])
      .then(([p, m]) => {
        setPlugins(p);
        setMarketplaces(m);
      })
      .catch((e) => setLoadError(isIpcError(e) ? e.message : "Could not load plugins"));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = (command: string, label: string) => {
    setActiveCommand(command);
    setActiveLabel(label);
  };
  const finishRun = () => {
    setActiveCommand(null);
    load();
  };

  const skills = (plugins ?? []).filter((p) => (p.id ?? "").endsWith("@skills-dir"));
  const regularPlugins = (plugins ?? []).filter((p) => !(p.id ?? "").endsWith("@skills-dir"));

  return (
    <div style={{ marginTop: "var(--space-2)" }}>
      <p style={{ color: "var(--color-fg-primary)", fontSize: "var(--text-sm)", fontWeight: 600, padding: "0 var(--space-3)" }}>
        Plugins &amp; Skills
      </p>
      <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)", padding: "0 var(--space-3)", marginTop: "var(--space-1)", maxWidth: "640px" }}>
        Every action below runs the real <code>claude plugin</code> command in a small terminal — nothing here is
        hand-rolled or simulated.
      </p>

      {loadError && <Banner tone="error" text={loadError} />}

      {activeCommand && (
        <div style={{ margin: "var(--space-3)", padding: "var(--space-3)", border: "1px solid var(--color-border-subtle)", borderRadius: "var(--radius-md)", background: "var(--color-bg-recessed)" }}>
          <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)", marginBottom: "var(--space-2)" }}>
            Running: <code>{activeLabel}</code>
          </p>
          <InlineTerminal key={activeCommand} command={activeCommand} onExit={finishRun} />
        </div>
      )}

      {plugins === null || marketplaces === null ? (
        <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)", padding: "var(--space-3)" }}>Loading…</p>
      ) : (
        <>
          <PluginsMarketplacesBlock marketplaces={marketplaces} onRun={run} />
          <PluginsInstalledBlock plugins={regularPlugins} marketplaces={marketplaces} onRun={run} />
          <PluginsBrowseBlock installed={plugins} onRun={run} />
          <PluginsSkillsBlock skills={skills} onRun={run} />
        </>
      )}
    </div>
  );
}

function PluginsSectionBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ margin: "var(--space-3)", padding: "var(--space-3) var(--space-4)", border: "1px solid var(--color-border-subtle)", borderRadius: "var(--radius-md)" }}>
      <p style={{ color: "var(--color-fg-primary)", fontSize: "var(--text-xs)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "var(--space-2)" }}>
        {title}
      </p>
      {children}
    </div>
  );
}

function PluginsMarketplacesBlock({
  marketplaces,
  onRun,
}: {
  marketplaces: MarketplaceEntry[];
  onRun: (command: string, label: string) => void;
}) {
  const [source, setSource] = useState("");
  const add = () => {
    const v = source.trim();
    if (!v) return;
    onRun(`claude plugin marketplace add ${shellQuote(v)}`, `plugin marketplace add ${v}`);
    setSource("");
  };
  return (
    <PluginsSectionBlock title={`Marketplaces (${marketplaces.length})`}>
      {marketplaces.length === 0 ? (
        <p style={pluginsMutedStyle}>None configured.</p>
      ) : (
        <ul className="flex flex-col gap-[2px]" style={{ marginBottom: "var(--space-2)" }}>
          {marketplaces.map((m) => {
            const name = m.name;
            return (
              <li key={name ?? m.installLocation ?? Math.random()} className="flex flex-wrap items-center justify-between gap-1" style={pluginsRowStyle}>
                <span style={pluginsMonoStyle}>
                  {name ?? "?"}{" "}
                  <span style={{ color: "var(--color-fg-muted)" }}>
                    · {m.source ?? "?"}
                    {m.repo ? ` · ${m.repo}` : m.url ? ` · ${m.url}` : m.path ? ` · ${m.path}` : ""}
                  </span>
                </span>
                {name && (
                  <button
                    type="button"
                    onClick={() => onRun(`claude plugin marketplace remove ${shellQuote(name)}`, `plugin marketplace remove ${name}`)}
                    className="cursor-pointer"
                    style={pluginsSmallBtnStyle}
                  >
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex items-center gap-[var(--space-2)]">
        <input
          value={source}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="owner/repo or a URL"
          spellCheck={false}
          className="min-w-0 flex-1"
          style={pluginsInputStyle}
        />
        <button type="button" onClick={add} disabled={!source.trim()} style={primaryBtnStyle(!!source.trim())}>
          Add
        </button>
      </div>
    </PluginsSectionBlock>
  );
}

function PluginsInstalledBlock({
  plugins,
  marketplaces,
  onRun,
}: {
  plugins: PluginEntry[];
  marketplaces: MarketplaceEntry[];
  onRun: (command: string, label: string) => void;
}) {
  const [name, setName] = useState("");
  const [marketplace, setMarketplace] = useState("");
  const install = () => {
    const n = name.trim();
    if (!n) return;
    const spec = marketplace.trim() ? `${n}@${marketplace.trim()}` : n;
    onRun(`claude plugin install ${shellQuote(spec)}`, `plugin install ${spec}`);
    setName("");
  };
  return (
    <PluginsSectionBlock title={`Plugins (${plugins.length})`}>
      {plugins.length === 0 ? (
        <p style={pluginsMutedStyle}>None installed.</p>
      ) : (
        <ul className="flex flex-col gap-[2px]" style={{ marginBottom: "var(--space-2)" }}>
          {plugins.map((p) => {
            const id = p.id;
            const { name: pname, source } = splitPluginId(id);
            return (
              <li key={id ?? Math.random()} className="flex flex-wrap items-center justify-between gap-1" style={pluginsRowStyle}>
                <span style={pluginsMonoStyle}>
                  {pname} <span style={{ color: "var(--color-fg-muted)" }}>@{source}{p.version ? ` · v${p.version}` : ""}</span>{" "}
                  <span style={{ color: p.enabled ? "var(--color-status-success)" : "var(--color-fg-muted)" }}>
                    {p.enabled ? "enabled" : "disabled"}
                  </span>
                </span>
                {id && (
                  <span className="flex items-center gap-[var(--space-1)]">
                    <button
                      type="button"
                      onClick={() => onRun(`claude plugin ${p.enabled ? "disable" : "enable"} ${shellQuote(id)}`, `plugin ${p.enabled ? "disable" : "enable"} ${id}`)}
                      className="cursor-pointer"
                      style={pluginsSmallBtnStyle}
                    >
                      {p.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      type="button"
                      onClick={() => onRun(`claude plugin uninstall ${shellQuote(id)}`, `plugin uninstall ${id}`)}
                      className="cursor-pointer"
                      style={pluginsSmallBtnStyle}
                    >
                      Uninstall
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex items-center gap-[var(--space-2)]" style={{ flexWrap: "wrap" }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="plugin name" spellCheck={false} className="min-w-0 flex-1" style={pluginsInputStyle} />
        <select value={marketplace} onChange={(e) => setMarketplace(e.target.value)} className="cursor-pointer" style={pluginsInputStyle}>
          <option value="">any marketplace</option>
          {marketplaces
            .filter((m) => m.name)
            .map((m) => (
              <option key={m.name} value={m.name as string}>
                {m.name}
              </option>
            ))}
        </select>
        <button type="button" onClick={install} disabled={!name.trim()} style={primaryBtnStyle(!!name.trim())}>
          Install
        </button>
      </div>
    </PluginsSectionBlock>
  );
}

/** Browse & install plugins from configured marketplaces (Addendum III §S14,
 *  feature 3/4). The catalog can be large (hundreds), so results are search-
 *  gated and capped; installing runs the CLI's own `plugin install` in the
 *  shared InlineTerminal, never a hand-rolled mutation. */
function PluginsBrowseBlock({
  installed,
  onRun,
}: {
  installed: PluginEntry[];
  onRun: (command: string, label: string) => void;
}) {
  const [available, setAvailable] = useState<AvailablePlugin[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    listAvailablePlugins()
      .then(setAvailable)
      .catch((e) => setLoadError(isIpcError(e) ? e.message : "Could not load the plugin catalog"));
  }, []);

  const installedNames = new Set(installed.map((p) => splitPluginId(p.id).name).filter(Boolean));
  const q = query.trim().toLowerCase();
  const matches = q
    ? (available ?? []).filter(
        (p) =>
          (p.name ?? "").toLowerCase().includes(q) ||
          (p.description ?? "").toLowerCase().includes(q) ||
          (p.category ?? "").toLowerCase().includes(q),
      )
    : [];
  const CAP = 40;
  const shown = matches.slice(0, CAP);

  return (
    <PluginsSectionBlock title={`Browse${available ? ` (${available.length})` : ""}`}>
      {loadError && <p style={pluginsMutedStyle}>{loadError}</p>}
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={available ? `Search ${available.length} plugins…` : "Loading catalog…"}
        spellCheck={false}
        className="min-w-0 w-full"
        style={{ ...pluginsInputStyle, marginBottom: "var(--space-2)" }}
      />
      {!q ? (
        <p style={pluginsMutedStyle}>Type to search installable plugins from your marketplaces.</p>
      ) : shown.length === 0 ? (
        <p style={pluginsMutedStyle}>No matches.</p>
      ) : (
        <ul className="flex flex-col gap-[2px]">
          {shown.map((p) => {
            const isInstalled = p.name != null && installedNames.has(p.name);
            const id = p.name && p.marketplace ? `${p.name}@${p.marketplace}` : (p.name ?? "");
            return (
              <li key={id || Math.random()} className="flex flex-wrap items-start justify-between gap-1" style={pluginsRowStyle}>
                <div className="min-w-0" style={{ flex: 1 }}>
                  <div style={pluginsMonoStyle}>
                    {p.name}{" "}
                    <span style={{ color: "var(--color-fg-muted)" }}>
                      {p.category ? `· ${p.category} ` : ""}· {p.marketplace}
                    </span>
                  </div>
                  {p.description && (
                    <div style={{ color: "var(--color-fg-muted)", fontSize: "var(--text-xs)", marginTop: "2px", overflowWrap: "anywhere" }}>
                      {p.description.length > 140 ? `${p.description.slice(0, 140)}…` : p.description}
                    </div>
                  )}
                </div>
                {isInstalled ? (
                  <span style={{ ...pluginsMonoStyle, color: "var(--color-status-success)" }}>installed</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onRun(`claude plugin install ${shellQuote(id)}`, `plugin install ${id}`)}
                    disabled={!id}
                    style={primaryBtnStyle(!!id)}
                  >
                    Install
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {matches.length > CAP && (
        <p style={pluginsMutedStyle}>
          Showing {CAP} of {matches.length} — refine your search.
        </p>
      )}
    </PluginsSectionBlock>
  );
}

function PluginsSkillsBlock({ skills, onRun }: { skills: PluginEntry[]; onRun: (command: string, label: string) => void }) {
  const [name, setName] = useState("");
  const create = () => {
    const n = name.trim();
    if (!n) return;
    onRun(`claude plugin init ${shellQuote(n)} --with skills`, `plugin init ${n} --with skills`);
    setName("");
  };
  return (
    <PluginsSectionBlock title={`Skills (${skills.length})`}>
      {skills.length === 0 ? (
        <p style={pluginsMutedStyle}>None yet.</p>
      ) : (
        <ul className="flex flex-col gap-[2px]" style={{ marginBottom: "var(--space-2)" }}>
          {skills.map((s) => {
            const id = s.id;
            const { name: sname } = splitPluginId(id);
            return (
              <li key={id ?? Math.random()} className="flex flex-wrap items-center justify-between gap-1" style={pluginsRowStyle}>
                <span style={pluginsMonoStyle}>
                  /{sname} {s.version && <span style={{ color: "var(--color-fg-muted)" }}>· v{s.version}</span>}
                </span>
                {id && (
                  <button type="button" onClick={() => onRun(`claude plugin uninstall ${shellQuote(id)}`, `plugin uninstall ${id}`)} className="cursor-pointer" style={pluginsSmallBtnStyle}>
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex items-center gap-[var(--space-2)]">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
          placeholder="skill-name"
          spellCheck={false}
          className="min-w-0 flex-1"
          style={pluginsInputStyle}
        />
        <button type="button" onClick={create} disabled={!name.trim()} style={primaryBtnStyle(!!name.trim())}>
          New skill
        </button>
      </div>
    </PluginsSectionBlock>
  );
}

const pluginsRowStyle: CSSProperties = {
  padding: "var(--space-1) var(--space-2)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-bg-base)",
};
const pluginsMonoStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--color-fg-primary)",
};
const pluginsMutedStyle: CSSProperties = {
  color: "var(--color-fg-muted)",
  fontSize: "var(--text-xs)",
  marginBottom: "var(--space-2)",
};
const pluginsInputStyle: CSSProperties = {
  background: "var(--color-bg-base)",
  border: "1px solid var(--color-border-subtle)",
  borderRadius: "var(--radius-sm)",
  padding: "var(--space-1) var(--space-2)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--color-fg-primary)",
};
const pluginsSmallBtnStyle: CSSProperties = {
  border: "none",
  borderRadius: "var(--radius-sm)",
  padding: "2px var(--space-2)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  background: "transparent",
  color: "var(--color-fg-secondary)",
};
const pluginsPrimaryBtnStyle: CSSProperties = {
  border: "1px solid var(--color-border-strong)",
  borderRadius: "var(--radius-sm)",
  padding: "var(--space-1) var(--space-3)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  background: "transparent",
  color: "var(--color-fg-primary)",
};
// A primary action (Add / Install / New skill) is disabled until its input has
// text — so give the disabled state a visible cue (dimmed + not-allowed cursor),
// otherwise the button looks live but silently does nothing when clicked.
function primaryBtnStyle(enabled: boolean): CSSProperties {
  return { ...pluginsPrimaryBtnStyle, opacity: enabled ? 1 : 0.4, cursor: enabled ? "pointer" : "not-allowed" };
}

// ---- MCP Servers (Addendum III §S12) -----------------------------------------
// Never hand-rolled: `claude mcp list` has no `--json`, so `mcp.rs` is a
// best-effort parse of its human-readable text (never fabricated — a line
// that doesn't fit is just skipped). Every mutating action runs the CLI's own
// command through InlineTerminal, same pattern as Plugins & Skills / Account.

function mcpStatusColor(status: string): string {
  if (/fail/i.test(status)) return "var(--color-status-danger)";
  if (/need.*auth/i.test(status)) return "var(--color-status-awaiting)";
  if (/connect/i.test(status)) return "var(--color-status-success)";
  return "var(--color-fg-muted)";
}

function McpSection() {
  const [servers, setServers] = useState<McpServerEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeCommand, setActiveCommand] = useState<string | null>(null);
  const [activeLabel, setActiveLabel] = useState("");
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [transport, setTransport] = useState<"" | "http" | "sse">("");

  const load = () => {
    setLoadError(null);
    listMcpServers()
      .then(setServers)
      .catch((e) => setLoadError(isIpcError(e) ? e.message : "Could not load MCP servers"));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = (command: string, label: string) => {
    setActiveCommand(command);
    setActiveLabel(label);
  };
  const finishRun = () => {
    setActiveCommand(null);
    load();
  };

  const add = () => {
    const n = name.trim();
    const t = target.trim();
    if (!n || !t) return;
    const flag = transport ? `--transport ${transport} ` : "";
    run(`claude mcp add ${flag}${shellQuote(n)} ${shellQuote(t)}`, `mcp add ${n}`);
    setName("");
    setTarget("");
    setTransport("");
  };

  return (
    <div style={{ marginTop: "var(--space-2)" }}>
      <p style={{ color: "var(--color-fg-primary)", fontSize: "var(--text-sm)", fontWeight: 600, padding: "0 var(--space-3)" }}>
        MCP Servers
      </p>
      <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)", padding: "0 var(--space-3)", marginTop: "var(--space-1)", maxWidth: "640px" }}>
        Every action below runs the real <code>claude mcp</code> command in a small terminal. Status text is the
        CLI's own, verbatim — <code>claude mcp list</code> has no structured output to read instead.
      </p>

      {loadError && <Banner tone="error" text={loadError} />}

      {activeCommand && (
        <div style={{ margin: "var(--space-3)", padding: "var(--space-3)", border: "1px solid var(--color-border-subtle)", borderRadius: "var(--radius-md)", background: "var(--color-bg-recessed)" }}>
          <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)", marginBottom: "var(--space-2)" }}>
            Running: <code>{activeLabel}</code>
          </p>
          <InlineTerminal key={activeCommand} command={activeCommand} onExit={finishRun} />
        </div>
      )}

      {servers === null ? (
        <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)", padding: "var(--space-3)" }}>Checking server health…</p>
      ) : (
        <PluginsSectionBlock title={`Servers (${servers.length})`}>
          {servers.length === 0 ? (
            <p style={pluginsMutedStyle}>None configured.</p>
          ) : (
            <ul className="flex flex-col gap-[2px]" style={{ marginBottom: "var(--space-2)" }}>
              {servers.map((s) => (
                <li key={s.name} className="flex flex-wrap items-center justify-between gap-1" style={pluginsRowStyle}>
                  <span style={pluginsMonoStyle}>
                    {s.name}{" "}
                    <span style={{ color: "var(--color-fg-muted)" }}>
                      · {s.target}
                      {s.transport ? ` (${s.transport})` : ""}
                    </span>{" "}
                    <span style={{ color: mcpStatusColor(s.status) }}>{s.status}</span>
                  </span>
                  <span className="flex items-center gap-[var(--space-1)]">
                    <button type="button" onClick={() => run(`claude mcp login ${shellQuote(s.name)}`, `mcp login ${s.name}`)} className="cursor-pointer" style={pluginsSmallBtnStyle}>
                      Login
                    </button>
                    <button type="button" onClick={() => run(`claude mcp logout ${shellQuote(s.name)}`, `mcp logout ${s.name}`)} className="cursor-pointer" style={pluginsSmallBtnStyle}>
                      Logout
                    </button>
                    <button type="button" onClick={() => run(`claude mcp remove ${shellQuote(s.name)}`, `mcp remove ${s.name}`)} className="cursor-pointer" style={pluginsSmallBtnStyle}>
                      Remove
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-[var(--space-2)]" style={{ flexWrap: "wrap" }}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="name"
              spellCheck={false}
              className="min-w-0"
              style={{ ...pluginsInputStyle, width: "120px" }}
            />
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="URL or local command"
              spellCheck={false}
              className="min-w-0 flex-1"
              style={pluginsInputStyle}
            />
            <select value={transport} onChange={(e) => setTransport(e.target.value as "" | "http" | "sse")} className="cursor-pointer" style={pluginsInputStyle}>
              <option value="">stdio (local command)</option>
              <option value="http">http</option>
              <option value="sse">sse</option>
            </select>
            <button
              type="button"
              onClick={add}
              disabled={!name.trim() || !target.trim()}
              style={primaryBtnStyle(!!name.trim() && !!target.trim())}
            >
              Add
            </button>
          </div>
        </PluginsSectionBlock>
      )}
    </div>
  );
}

// ---- Apply / Discard footer -------------------------------------------------

function Footer({ dirty, disabled, hidden }: { dirty: boolean; disabled: boolean; hidden: boolean }) {
  if (hidden) return null;
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

function JsonEditor({ settings, onDone }: { settings: ScopeSettings; onDone: () => void }) {
  const [text, setText] = useState(() => JSON.stringify(settings, null, 2));
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
    setError(null);
    useSettings.getState().replaceDraft(sanitizeScopeSettings(parsed as Record<string, unknown>));
    onDone();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ padding: "var(--space-6)", gap: "var(--space-3)" }}>
      <p style={{ color: "var(--color-fg-secondary)", fontSize: "var(--text-xs)" }}>
        Editing the staged scope as JSON — every category at once. Unknown keys are ignored; “Update draft” stages it — then
        Apply to save.
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
