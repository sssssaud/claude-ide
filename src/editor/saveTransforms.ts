/*
 * Pure text transforms applied on save (Addendum II §1.2, S2). No Monaco/DOM
 * dependency so they're easy to reason about in isolation; `EditorPane` applies
 * the result back into the model as a single edit.
 */

/** Strip trailing spaces/tabs from every line. Skipped for Markdown, where
 *  trailing whitespace is a significant hard line-break. */
export function trimTrailingWhitespace(text: string, language: string): string {
  if (language === "markdown") return text;
  return text.replace(/[ \t]+(?=\r?\n|$)/g, "");
}

/** Collapse excess trailing blank lines to at most one final newline
 *  (`trimFinal`), then ensure exactly one is present (`insertFinal`). Mirrors
 *  VS Code's `files.trimFinalNewlines` / `files.insertFinalNewline`. */
export function normalizeFinalNewlines(text: string, insertFinal: boolean, trimFinal: boolean): string {
  let out = text;
  if (trimFinal) {
    out = out.replace(/(\r?\n)+$/, "\n");
  }
  if (insertFinal && out.length > 0 && !/\r?\n$/.test(out)) {
    out += "\n";
  }
  return out;
}
