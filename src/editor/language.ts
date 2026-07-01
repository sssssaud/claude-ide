/* Monaco language id by file extension; falls back to plaintext. */

const EXTENSION_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  rs: "rust",
  py: "python",
  md: "markdown",
  markdown: "markdown",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  sh: "shell",
  bash: "shell",
  sql: "sql",
  go: "go",
  c: "c",
  h: "c",
  cpp: "cpp",
  java: "java",
};

export function languageForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return EXTENSION_MAP[ext] ?? "plaintext";
}

/** Friendly label per Monaco language id (Status Bar language picker,
 *  Addendum II §S5). Covers every id `languageForPath` can produce. */
const LANGUAGE_LABELS: Record<string, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  json: "JSON",
  rust: "Rust",
  python: "Python",
  markdown: "Markdown",
  css: "CSS",
  scss: "SCSS",
  less: "Less",
  html: "HTML",
  xml: "XML",
  yaml: "YAML",
  ini: "INI/TOML",
  shell: "Shell Script",
  sql: "SQL",
  go: "Go",
  c: "C",
  cpp: "C++",
  java: "Java",
  plaintext: "Plain Text",
};

export interface LanguageOption {
  id: string;
  label: string;
}

/** Every language the picker offers: everything `languageForPath` can produce,
 *  deduped, friendly-labeled, alphabetical. One source of truth with
 *  `EXTENSION_MAP` so this can't silently drift out of sync with it. */
export const LANGUAGE_OPTIONS: LanguageOption[] = Array.from(
  new Set([...Object.values(EXTENSION_MAP), "plaintext"]),
)
  .map((id) => ({ id, label: LANGUAGE_LABELS[id] ?? id }))
  .sort((a, b) => a.label.localeCompare(b.label));

export function languageLabel(id: string): string {
  return LANGUAGE_LABELS[id] ?? id;
}
