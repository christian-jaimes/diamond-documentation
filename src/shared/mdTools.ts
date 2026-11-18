// Editor-agnostic Markdown helpers: paste link, table of contents, table navigation
// and list renumbering. Same contract as format.ts (offsets in, EditResult out).
import { Change, EditResult, Sel, linesOf, lineIndexAt, splitRow } from './format';

const lo = (s: Sel) => Math.min(s.anchor, s.head);
const hi = (s: Sel) => Math.max(s.anchor, s.head);

// ------------------------------------------------------------------ paste link
const URL_ONLY = /^(?:https?:\/\/|mailto:|www\.)\S+$/i;

/** Pasting a URL over selected text turns the selection into `[text](url)`. */
export function pasteLink(text: string, sels: Sel[], clip: string): EditResult | undefined {
  const url = clip.trim();
  if (!URL_ONLY.test(url) || sels.length !== 1 || lo(sels[0]) === hi(sels[0])) { return undefined; }
  const from = lo(sels[0]), to = hi(sels[0]);
  const label = text.slice(from, to);
  if (label.includes('\n') || /^\[.*\]\(.*\)$/.test(label) || URL_ONLY.test(label.trim())) { return undefined; }
  const insert = `[${label}](${/^www\./i.test(url) ? 'https://' + url : url})`;
  return { changes: [{ from, to, insert }], selections: [{ anchor: from + insert.length, head: from + insert.length }] };
}

// ------------------------------------------------------------------ table of contents
export const TOC_START = '<!-- toc -->';
export const TOC_END = '<!-- /toc -->';

interface Heading { level: number; text: string; }

function headingsOf(text: string): Heading[] {
  const out: Heading[] = [];
  let fence: string | undefined;
  const lines = text.split(/\r?\n/);
  let i = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, n) => n > 0 && l.trim() === '---');
    if (end > 0) { i = end + 1; }
  }
  for (; i < lines.length; i++) {
    const f = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (f) {
      if (!fence) { fence = f[1]; } else if (f[1][0] === fence[0] && f[1].length >= fence.length) { fence = undefined; }
      continue;
    }
    if (fence) { continue; }
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (m) { out.push({ level: m[1].length, text: m[2] }); }
  }
  return out;
}

const anchorOf = (h: string) => h.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');

/** Nested bullet list linking to every heading (a lone `#` document title is left out). */
export function tocList(text: string): string {
  let hs = headingsOf(text);
  if (hs.filter(h => h.level === 1).length === 1 && hs[0]?.level === 1) { hs = hs.slice(1); }
  if (!hs.length) { return '_No headings yet._'; }
  const base = Math.min(...hs.map(h => h.level));
  const seen = new Map<string, number>();
  return hs.map(h => {
    const slug = anchorOf(h.text);
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    const label = h.text.replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, '$1').replace(/[[\]]/g, '');
    return `${'  '.repeat(h.level - base)}- [${label}](#${slug}${n ? '-' + n : ''})`;
  }).join('\n');
}

/** Refresh the table of contents between the markers, or insert one at `pos` when there is none. */
export function updateToc(text: string, pos: number): EditResult | undefined {
  const start = text.indexOf(TOC_START);
  const end = start >= 0 ? text.indexOf(TOC_END, start) : -1;
  if (start >= 0 && end > start) {
    const bodyFrom = start + TOC_START.length;
    const insert = '\n\n' + tocList(text.slice(0, start) + text.slice(end + TOC_END.length)) + '\n\n';
    if (text.slice(bodyFrom, end) === insert) { return undefined; }
    const keep = pos <= bodyFrom ? pos : bodyFrom;
    return { changes: [{ from: bodyFrom, to: end, insert }], selections: [{ anchor: keep, head: keep }] };
  }
  const lines = linesOf(text);
  const line = lines[lineIndexAt(lines, pos)];
  const blank = !line.text.trim();
  const insert = (blank ? '' : '\n\n') + `${TOC_START}\n\n${tocList(text)}\n\n${TOC_END}\n`;
  const at = blank ? line.from : line.to;
  return { changes: [{ from: at, to: blank ? line.to : at, insert }], selections: [{ anchor: at + insert.length, head: at + insert.length }] };
}

// ------------------------------------------------------------------ table navigation
const isTableRow = (t: string) => /^\s*\|.*\|\s*$/.test(t);
const isSep = (r: string[]) => r.length > 0 && r.every(c => /^:?-+:?$/.test(c));

/** Content ranges `[from, to)` (line-relative, trimmed) of every cell in a table row. */
function cellRanges(line: string): [number, number][] {
  const bars: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; } else if (line[i] === '|') { bars.push(i); }
  }
  const out: [number, number][] = [];
  for (let k = 0; k + 1 < bars.length; k++) {
    let from = bars[k] + 1, to = bars[k + 1];
    while (from < to && line[from] === ' ') { from++; }
    while (to > from && line[to - 1] === ' ') { to--; }
    out.push([from, to]);
  }
  return out;
}

/**
 * Tab / Shift+Tab inside a table: select the next / previous cell without touching the
 * text. Tab in the last cell appends an empty row. Returns undefined when `pos` is not in a table.
 */
export function tableNavigate(text: string, pos: number, forward: boolean): EditResult | undefined {
  const lines = linesOf(text);
  const li = lineIndexAt(lines, pos);
  if (!isTableRow(lines[li].text)) { return undefined; }
  let start = li, end = li;
  while (start > 0 && isTableRow(lines[start - 1].text)) { start--; }
  while (end < lines.length - 1 && isTableRow(lines[end + 1].text)) { end++; }

  const isSepLine = (i: number) => isSep(splitRow(lines[i].text));
  const rel = pos - lines[li].from;
  const cells = cellRanges(lines[li].text);
  let col = cells.findIndex(([, to], k) => rel <= to + 1 || k === cells.length - 1);
  if (col < 0) { col = 0; }
  const cols = cells.length;
  const dir = forward ? 1 : -1;
  let r = li, c = col;
  const step = () => { c += dir; if (c >= cols) { c = 0; r++; } else if (c < 0) { c = cols - 1; r--; } };
  step();
  while (r >= start && r <= end && isSepLine(r)) { step(); }
  if (r < start) { return { changes: [], selections: [{ anchor: pos, head: pos }] }; }
  if (r > end) {
    const indent = /^\s*/.exec(lines[start].text)![0];
    const row = '\n' + indent + '|' + '  |'.repeat(cols);
    return { changes: [{ from: lines[end].to, to: lines[end].to, insert: row }], selections: [{ anchor: lines[end].to + indent.length + 3, head: lines[end].to + indent.length + 3 }] };
  }
  const target = cellRanges(lines[r].text)[c] ?? [0, 0];
  return { changes: [], selections: [{ anchor: lines[r].from + target[0], head: lines[r].from + target[1] }] };
}

// ------------------------------------------------------------------ list numbering
/** Number every ordered list 1, 2, 3… (each list keeps its first number), level by level. */
export function renumberLists(text: string): EditResult | undefined {
  const changes: Change[] = [];
  let fence = false;
  const stack: { indent: number; n: number }[] = [];
  for (const l of linesOf(text)) {
    if (/^\s*(```|~~~)/.test(l.text)) { fence = !fence; continue; }
    if (fence || !l.text.trim()) { continue; }
    const m = /^(\s*)(\d+)([.)])\s+/.exec(l.text);
    const indent = (m ? m[1] : /^\s*/.exec(l.text)![0]).replace(/\t/g, '    ').length;
    while (stack.length && stack[stack.length - 1].indent > indent) { stack.pop(); }
    if (!m) {
      // Plain text at the list's own indent ends it; indented text continues the item.
      if (!/^\s*[-*+]\s/.test(l.text) && stack.length && stack[stack.length - 1].indent >= indent) { stack.pop(); }
      continue;
    }
    const top = stack[stack.length - 1];
    let n: number;
    if (top && top.indent === indent) { n = ++top.n; } else { n = +m[2]; stack.push({ indent, n }); }
    if (n !== +m[2]) { changes.push({ from: l.from + m[1].length, to: l.from + m[1].length + m[2].length, insert: String(n) }); }
  }
  return changes.length ? { changes, selections: [] } : undefined;
}
