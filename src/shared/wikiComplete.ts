// Pure helpers for [[wikilink]] autocomplete, shared by the live editor webview and unit-tested in plain Node.

/** What the cursor is completing, from the text of the line before it. */
export type WikiContext =
  | { kind: 'file'; query: string; /** length of the typed query */ typed: number }
  | { kind: 'heading'; target: string; query: string; typed: number };

/** `[[par` → file query `par`; `[[Note#Intro` → headings of `Note` matching `Intro`. Aliases (`|`) and finished links are not completed. */
export function wikiContext(before: string): WikiContext | undefined {
  const m = /\[\[([^\[\]|\n]*)$/.exec(before);
  if (!m) { return undefined; }
  const inner = m[1];
  const hash = inner.indexOf('#');
  if (hash < 0) { return { kind: 'file', query: inner, typed: inner.length }; }
  const query = inner.slice(hash + 1);
  return { kind: 'heading', target: inner.slice(0, hash).trim(), query, typed: query.length };
}

export interface FuzzyHit { score: number; /** matched character offsets in the text */ matched: number[]; }

const isSep = (c: string) => /[\s/\\._\-#]/.test(c);

/**
 * Subsequence match: every character of `query` must appear in `text` in order (case-insensitive).
 * Higher scores are better: consecutive runs, word starts and prefix/exact matches rank first.
 */
export function fuzzyMatch(query: string, text: string): FuzzyHit | undefined {
  if (!query) { return { score: 0, matched: [] }; }
  const q = query.toLowerCase(), t = text.toLowerCase();
  // Prefer a plain substring: score by position and word boundary.
  const at = t.indexOf(q);
  if (at >= 0) {
    const boundary = at === 0 || isSep(text[at - 1]) || (text[at] !== t[at] && text[at - 1] === text[at - 1].toLowerCase());
    const score = 1000 - at + (at === 0 ? 400 : 0) + (boundary ? 200 : 0) + (q.length === t.length ? 500 : 0) - (t.length - q.length) * 0.5;
    return { score, matched: Array.from({ length: q.length }, (_, i) => at + i) };
  }
  // Greedy subsequence with bonuses.
  const matched: number[] = [];
  let score = 0, prev = -2, ti = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi], ti);
    if (found < 0) { return undefined; }
    matched.push(found);
    score += 10;
    if (found === prev + 1) { score += 15; }
    if (found === 0 || isSep(text[found - 1])) { score += 12; }
    score -= Math.min(found - ti, 8);
    prev = found; ti = found + 1;
  }
  return { score: score - (t.length - q.length) * 0.2, matched };
}

export interface FileEntry { text: string; path: string; md: boolean; }
export interface RankedFile { entry: FileEntry; score: number; matched: number[]; }

/** Files matching `query` (by link text or path), best first. Notes outrank other files on equal footing. */
export function rankFiles(entries: FileEntry[], query: string, limit = 100): RankedFile[] {
  const out: RankedFile[] = [];
  for (const entry of entries) {
    const byName = fuzzyMatch(query, entry.text);
    const byPath = byName ? undefined : fuzzyMatch(query, entry.path);
    const hit = byName ?? byPath;
    if (!hit) { continue; }
    out.push({ entry, score: hit.score - (byPath ? 300 : 0) + (entry.md ? 5 : 0), matched: byName ? hit.matched : [] });
  }
  out.sort((a, b) => b.score - a.score || a.entry.text.length - b.entry.text.length || a.entry.text.localeCompare(b.entry.text));
  return out.slice(0, limit);
}
