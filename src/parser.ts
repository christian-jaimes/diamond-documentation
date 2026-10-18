// Pure parsing helpers (no vscode dependency), shared by the extension, the live
// editor webview and the preview plugin, and unit-tested in plain Node.

export type LinkKind = 'wiki' | 'markdown';

export interface ParsedLink {
  kind: LinkKind;
  embed: boolean;
  /** Raw target path/name without heading or alias, e.g. `docs/setup` */
  target: string;
  /** Heading or block reference after `#`, if any */
  heading?: string;
  alias?: string;
  line: number;
  /** Column range of the whole link, e.g. `[[target|alias]]` */
  start: number;
  end: number;
  /** Column range of just the target text (for click areas / rename edits) */
  targetStart: number;
  targetEnd: number;
  /** Markdown links: the destination exactly as written, e.g. `<a b.md#x>` */
  raw?: string;
  /** Trimmed text of the line, for backlink context */
  context: string;
}

export interface ParsedHeading { text: string; level: number; line: number; }

export interface ParsedNote { links: ParsedLink[]; headings: ParsedHeading[]; tags: string[]; }

const WIKI = /(!?)\[\[([^\[\]\n]+?)\]\]/g;
const MDLINK = /(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+["'][^"'\n]*["'])?\s*\)/g;
const TAG = /(?:^|\s)#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;
const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const INLINE_CODE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;

export const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;
export const IMAGE = /\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i;
export const MARKDOWN_FILE = /\.(md|markdown|mdx)$/i;

/** Split `target#heading|alias`. `aliasOffset` is where the alias starts (0 when there is none). */
export function splitWikiTarget(inner: string): { target: string; heading?: string; alias?: string; aliasOffset: number } {
  let alias: string | undefined;
  const pipe = inner.indexOf('|');
  if (pipe >= 0) { alias = inner.slice(pipe + 1).trim(); inner = inner.slice(0, pipe); }
  let heading: string | undefined;
  const hash = inner.indexOf('#');
  if (hash >= 0) { heading = inner.slice(hash + 1).trim(); inner = inner.slice(0, hash); }
  return { target: inner.trim(), heading, alias, aliasOffset: pipe + 1 };
}

export function parseNote(text: string): ParsedNote {
  const links: ParsedLink[] = [];
  const headings: ParsedHeading[] = [];
  const tags = new Set<string>();
  const lines = text.split(/\r?\n/);
  let fence: string | undefined;
  let inFrontMatter = lines[0]?.trim() === '---';

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const raw = lines[lineNo];
    if (inFrontMatter) {
      if (lineNo > 0 && /^(---|\.\.\.)\s*$/.test(raw)) { inFrontMatter = false; }
      continue;
    }
    const f = FENCE.exec(raw);
    if (f) {
      if (!fence) { fence = f[1][0]; continue; }
      if (f[1][0] === fence) { fence = undefined; continue; }
    }
    if (fence) { continue; }

    const h = raw.charCodeAt(0) === 35 /* # */ ? HEADING.exec(raw) : null;
    if (h) { headings.push({ level: h[1].length, text: h[2], line: lineNo }); }

    // Fast path: most lines contain neither links nor tags.
    const hasBracket = raw.includes('['), hasHash = raw.includes('#');
    if (!hasBracket && !hasHash) { continue; }
    // Blank out inline code so links inside it are ignored (keeps column positions).
    const line = raw.includes('`') ? raw.replace(INLINE_CODE, m => ' '.repeat(m.length)) : raw;
    const context = raw.trim();

    if (hasBracket) {
      for (const m of line.matchAll(WIKI)) {
        const inner = m[2];
        const { target, heading, alias } = splitWikiTarget(inner);
        const start = m.index!;
        const targetStart = start + m[1].length + 2 + Math.max(0, inner.indexOf(target));
        links.push({
          kind: 'wiki', embed: m[1] === '!', target, heading, alias, line: lineNo, start, end: start + m[0].length,
          targetStart, targetEnd: targetStart + (target.length || inner.length), context,
        });
      }
      for (const m of line.matchAll(MDLINK)) {
        let href = m[3];
        if (href.startsWith('<')) { href = href.slice(1, -1); }
        if (EXTERNAL.test(href) || href.startsWith('#')) { continue; }
        let heading: string | undefined;
        const hash = href.indexOf('#');
        if (hash >= 0) { heading = href.slice(hash + 1); href = href.slice(0, hash); }
        try { href = decodeURIComponent(href); } catch { /* keep raw */ }
        const start = m.index!;
        const hrefStart = line.indexOf('(', start + m[1].length + m[2].length + 2) + 1;
        links.push({
          kind: 'markdown', embed: m[1] === '!', target: href, heading, alias: m[2] || undefined,
          line: lineNo, start, end: start + m[0].length,
          targetStart: hrefStart, targetEnd: hrefStart + m[3].length, raw: m[3], context,
        });
      }
    }
    if (hasHash) {
      for (const m of line.matchAll(TAG)) { tags.add(m[1]); }
    }
  }
  return { links, headings, tags: [...tags] };
}

/** What other notes care about: link targets and tags (not positions or plain text). */
export function noteSignature(note: ParsedNote): string {
  return note.links.map(l => `${l.kind}${l.embed ? '!' : ''}:${l.target}#${l.heading ?? ''}`).join('|') + '||' + note.tags.join('|');
}

/** GitHub-style heading slug, used to match `[[note#Heading]]` and `file.md#heading`. */
export function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');
}
