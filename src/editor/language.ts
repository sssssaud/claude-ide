/* Monaco language id by file extension; falls back to plaintext. */
export function languageForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
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
  return map[ext] ?? "plaintext";
}
