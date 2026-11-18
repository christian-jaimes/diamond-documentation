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

/**
 * Tab / Shift+Tab inside a table: re-align it and select the next / previous cell.
 * Tab in the last cell adds a row. Returns undefined when `pos` is not in a table.
 */
export function tableNavigate(text: string, pos: number, forward: boolean): EditResult | undefined {
  const lines = linesOf(text);
  const li = lineIndexAt(lines, pos);
  if (!isTableRow(lines[li].text)) { return undefined; }
  let start = li, end = li;
  while (start > 0 && isTableRow(lines[start - 1].text)) { start--; }
  while (end < lines.length - 1 && isTableRow(lines[end + 1].text)) { end++; }

  let rows = lines.slice(start, end + 1).map(l => splitRow(l.text));
  const cols = Math.max(...rows.map(r => r.length));
  const before = lines[li].text.slice(0, pos - lines[li].from).replace(/\\\|/g, '');
  const col = Math.min(cols - 1, Math.max(0, (before.match(/\|/g)?.length ?? 1) - 1));
  const row = li - start;

  const dir = forward ? 1 : -1;
  let r = row, c = col;
  const step = () => { c += dir; if (c >= cols) { c = 0; r++; } else if (c < 0) { c = cols - 1; r--; } };
  step();
  while (r >= 0 && r < rows.length && isSep(rows[r])) { step(); }
  if (r < 0) { r = row; c = col; }
  if (r >= rows.length) { rows = [...rows, Array.from({ length: cols }, () => '')]; r = rows.length - 1; c = 0; }

  const widths = Array.from({ length: cols }, (_, k) => Math.max(3, ...rows.filter(x => !isSep(x)).map(x => (x[k] ?? '').length)));
  const indent = /^\s*/.exec(lines[start].text)![0];
  const out = rows.map(x => indent + (isSep(x)
    ? '| ' + widths.map((w, k) => {
      const cell = x[k] ?? '---';
      return (cell.startsWith(':') ? ':' : '-') + '-'.repeat(w - 2) + (cell.endsWith(':') ? ':' : '-');
    }).join(' | ') + ' |'
    : '| ' + widths.map((w, k) => (x[k] ?? '').padEnd(w)).join(' | ') + ' |'));
  const from = lines[start].from, to = lines[end].to;
  let offset = out.slice(0, r).reduce((n, l) => n + l.length + 1, 0) + indent.length + 2;
  for (let k = 0; k < c; k++) { offset += widths[k] + 3; }
  const len = (rows[r][c] ?? '').length;
  return { changes: [{ from, to, insert: out.join('\n') }], selections: [{ anchor: from + offset, head: from + offset + len }] };
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
