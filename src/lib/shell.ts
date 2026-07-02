/*
 * Shared shell-quoting for text typed into a real PTY (Addendum II §S7's
 * "Open Terminal Here", Addendum III §S11's Plugins & Skills actions). Any
 * value interpolated into a command string written to a live shell — a path,
 * a URL, a plugin/skill name — must be quoted, since it may legally contain
 * shell metacharacters and this is a REAL shell, not a sandbox.
 */

/** Single-quote `value` for a literal shell argument — the standard POSIX
 *  escape (`'`, then any embedded `'` becomes `'\''`, then the closing `'`). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
