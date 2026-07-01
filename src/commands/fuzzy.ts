/*
 * A minimal subsequence fuzzy matcher (VS Code/Sublime-style), shared by the
 * Command Palette and Quick Open. Every query character must appear in
 * `target`, in order, case-insensitive; tighter and word-boundary matches
 * score higher. No dependency — the matching rule is simple enough to hand-roll.
 */

// Quick Open can fuzzy-filter thousands of file paths on every keystroke;
// `target` values repeat across calls (same file list, new query each time),
// so its lowercased form is worth caching — `query` changes every keystroke
// and isn't. Bounded in practice by the number of distinct paths/command
// titles ever shown, capped well below anything that matters memory-wise.
const lowerCache = new Map<string, string>();
function cachedLower(s: string): string {
  let v = lowerCache.get(s);
  if (v === undefined) {
    v = s.toLowerCase();
    lowerCache.set(s, v);
  }
  return v;
}

/** `null` = no match at all. Higher score = better match. */
export function fuzzyScore(query: string, target: string): number | null {
  if (query === "") return 0;
  const q = query.toLowerCase();
  const t = cachedLower(target);

  let ti = 0;
  let score = 0;
  let consecutive = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi], ti);
    if (found === -1) return null;
    const gap = found - ti;
    consecutive = gap === 0 ? consecutive + 1 : 0;
    score += 10 - Math.min(gap, 8); // reward tight matches
    score += consecutive * 3; // reward runs of consecutive characters
    const prev = t[found - 1];
    if (found === 0 || (prev && /[^a-z0-9]/.test(prev))) score += 5; // word-boundary bonus
    ti = found + 1;
  }
  score -= Math.floor(t.length / 20); // prefer shorter, more specific targets
  return score;
}

/** Filter + rank `items` by `query` against `text(item)`, best match first. */
export function fuzzyFilter<T>(items: T[], query: string, text: (item: T) => string): T[] {
  const q = query.trim();
  if (!q) return items;
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const score = fuzzyScore(q, text(item));
    if (score !== null) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}
