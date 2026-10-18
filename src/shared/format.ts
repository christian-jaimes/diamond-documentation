// Editor-agnostic formatting operations. They take the document text and the
// selections (as offsets) and return the changes to apply plus the selections
// afterwards, so the same logic drives both the source editor and the live editor.

export interface Sel { anchor: number; head: number; }
export interface Change { from: number; to: number; insert: string; }
/** `changes` use offsets of the original text; `selections` use offsets of the new text. */
export interface EditResult { changes: Change[]; selections: Sel[]; }

const WORD_CHAR = /[^\s`*~=_\[\]]/;

const lo = (s: Sel) => Math.min(s.anchor, s.head);
const hi = (s: Sel) => Math.max(s.anchor, s.head);

/** Wrap / unwrap every selection with `marker` (e.g. `**`, `==`). */
export function toggleWrap(text: string, sels: Sel[], marker: string): EditResult {
  const len = marker.length;
  const ranges = sels.map(sel => {
    let s = lo(sel), e = hi(sel);
    if (s === e) {
      let a = s, b = s;
      while (a > 0 && WORD_CHAR.test(text[a - 1])) { a--; }
      while (b < text.length && WORD_CHAR.test(text[b])) { b++; }
      if (a < b) { s = a; e = b; }
    }
    return [s, e] as const;
  }).sort((x, y) => x[0] - y[0]);

  const changes: Change[] = [];
  const selections: Sel[] = [];
  let shift = 0;
  for (const [s, e] of ranges) {
    const inner = text.slice(s, e);
    if (inner.length >= 2 * len && inner.startsWith(marker) && inner.endsWith(marker)) {
      // Markers are inside the selection: [**text**]
      changes.push({ from: s, to: e, insert: inner.slice(len, -len) });
      selections.push({ anchor: s + shift, head: e - 2 * len + shift });
      shift -= 2 * len;
    } else if (s >= len && text.slice(s - len, s) === marker && text.slice(e, e + len) === marker) {
      // Markers surround the selection: **[text]**
      changes.push({ from: s - len, to: s, insert: '' }, { from: e, to: e + len, insert: '' });
      selections.push({ anchor: s - len + shift, head: e - len + shift });
      shift -= 2 * len;
    } else {
      changes.push({ from: s, to: e, insert: marker + inner + marker });
      selections.push({ anchor: s + len + shift, head: e + len + shift });
      shift += 2 * len;
    }
  }
  return { changes, selections };
}

/** Map an offset through changes; offsets inside a changed span keep their distance to its end. */
function mapPos(pos: number, changes: Change[]): number {
  let delta = 0;
  for (const c of changes) {
    if (pos > c.to) { delta += c.insert.length - (c.to - c.from); continue; }
    if (pos >= c.from) { return c.from + delta + Math.max(0, c.insert.length - (c.to - pos)); }
    break;
  }
  return pos + delta;
}

interface Line { from: number; to: number; text: string; }

function linesOf(text: string): Line[] {
  const out: Line[] = [];
  let from = 0;
  for (const t of text.split('\n')) { out.push({ from, to: from + t.length, text: t }); from += t.length + 1; }
  return out;
}

function lineIndexAt(lines: Line[], pos: number): number {
  let lo = 0, hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid].from <= pos) { lo = mid; } else { hi = mid - 1; }
  }
  return lo;
}

/** Apply `fn` to every line touched by a selection. */
export function transformLines(text: string, sels: Sel[], fn: (line: string, index: number, all: string[]) => string): EditResult {
  const lines = linesOf(text);
  const touched = new Set<number>();
  for (const sel of sels) {
    const a = lineIndexAt(lines, lo(sel));
    let b = lineIndexAt(lines, hi(sel));
    if (b > a && hi(sel) === lines[b].from) { b--; }
    for (let i = a; i <= b; i++) { touched.add(i); }
  }
  const idx = [...touched].sort((x, y) => x - y);
  const texts = idx.map(i => lines[i].text.replace(/\r$/, ''));
  const changes: Change[] = [];
  idx.forEach((li, i) => {
    const next = fn(texts[i], i, texts);
    if (next !== texts[i]) { changes.push({ from: lines[li].from, to: lines[li].from + texts[i].length, insert: next }); }
  });
  return { changes, selections: sels.map(s => ({ anchor: mapPos(s.anchor, changes), head: mapPos(s.head, changes) })) };
}

export const BULLET = /^(\s*)([-*+])\s+/;
export const NUMBERED = /^(\s*)(\d+)[.)]\s+/;
export const CHECKBOX = /^(\s*)([-*+]|\d+[.)])\s+\[([ xX])\]\s?/;

export function toggleCheckboxLine(line: string): string {
  const m = CHECKBOX.exec(line);
  if (m) { return line.replace(CHECKBOX, `${m[1]}${m[2]} [${m[3] !== ' ' ? ' ' : 'x'}] `); }
  const b = BULLET.exec(line) || NUMBERED.exec(line);
  if (b) { return line.replace(b[0], `${b[0]}[ ] `); }
  const indent = /^\s*/.exec(line)![0];
  return `${indent}- [ ] ${line.trimStart()}`;
}

export function toggleBulletLine(line: string): string {
  if (CHECKBOX.test(line)) { return line.replace(CHECKBOX, '$1'); }
  if (BULLET.test(line)) { return line.replace(BULLET, '$1'); }
  if (NUMBERED.test(line)) { return line.replace(NUMBERED, '$1- '); }
  const indent = /^\s*/.exec(line)![0];
  return `${indent}- ${line.trimStart()}`;
}

export function toggleNumberedLine(line: string, i: number, all: string[]): string {
  if (all.every(l => NUMBERED.test(l))) { return line.replace(NUMBERED, '$1'); }
  const stripped = line.replace(CHECKBOX, '$1').replace(BULLET, '$1').replace(NUMBERED, '$1');
  const indent = /^\s*/.exec(stripped)![0];
  return `${indent}${i + 1}. ${stripped.trimStart()}`;
}

export function cycleHeadingLine(line: string): string {
  const m = /^(#{1,6})\s+/.exec(line);
  if (!m) { return `# ${line}`; }
  if (m[1].length >= 6) { return line.slice(m[0].length); }
  return `#${line}`;
}

export function toggleQuoteLine(line: string, _i: number, all: string[]): string {
  return all.every(l => /^\s*>/.test(l)) ? line.replace(/^(\s*)>\s?/, '$1') : `> ${line}`;
}

export const LINE_OPS = {
  checkbox: toggleCheckboxLine,
  bullet: toggleBulletLine,
  numbered: toggleNumberedLine,
  heading: cycleHeadingLine,
  quote: toggleQuoteLine,
};
export type LineOp = keyof typeof LINE_OPS;

export const WRAP_OPS = { bold: '**', italic: '*', strike: '~~', highlight: '==', code: '`' };
export type WrapOp = keyof typeof WRAP_OPS;

/** Replace the main selection with `insert`; select `[selFrom, selTo)` inside it (relative offsets). */
export function insertText(sels: Sel[], insert: string, selFrom = insert.length, selTo = selFrom): EditResult {
  const s = sels[0] ?? { anchor: 0, head: 0 };
  const from = lo(s);
  return { changes: [{ from, to: hi(s), insert }], selections: [{ anchor: from + selFrom, head: from + selTo }] };
}

/** Wrap the selected lines in a fenced code block, or insert an empty one. */
export function codeBlock(text: string, sels: Sel[], lang: string): EditResult {
  const s = sels[0] ?? { anchor: 0, head: 0 };
  const lines = linesOf(text);
  const a = lineIndexAt(lines, lo(s));
  let b = lineIndexAt(lines, hi(s));
  if (lo(s) === hi(s)) {
    const line = lines[a];
    const prefix = line.text.trim() ? '\n' : '';
    const insert = `${prefix}\`\`\`${lang}\n\n\`\`\``;
    const at = line.text.trim() ? line.to : line.from;
    const cursor = at + prefix.length + 4 + lang.length;
    return { changes: [{ from: at, to: line.to, insert }], selections: [{ anchor: cursor, head: cursor }] };
  }
  if (b > a && hi(s) === lines[b].from) { b--; }
  const from = lines[a].from, to = lines[b].to;
  const indent = /^\s*/.exec(lines[a].text)![0];
  const insert = `${indent}\`\`\`${lang}\n${text.slice(from, to)}\n${indent}\`\`\``;
  return { changes: [{ from, to, insert }], selections: [{ anchor: from + insert.length, head: from + insert.length }] };
}

/** Markdown for an empty table. Returns the text plus the range of the first header cell. */
export function tableText(cols: number, rows: number): { text: string; selFrom: number; selTo: number } {
  const header = '| ' + Array.from({ length: cols }, (_, i) => `Header ${i + 1}`).join(' | ') + ' |';
  const sep = '| ' + Array.from({ length: cols }, (_, i) => '-'.repeat(`Header ${i + 1}`.length)).join(' | ') + ' |';
  const body = Array.from({ length: rows }, () => '| ' + Array.from({ length: cols }, (_, i) => ' '.repeat(`Header ${i + 1}`.length)).join(' | ') + ' |');
  return { text: [header, sep, ...body].join('\n') + '\n', selFrom: 2, selTo: 10 };
}

/** Cells of a table row (`| a | b |` → `['a', 'b']`), ignoring escaped pipes. */
export function splitRow(row: string): string[] {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim());
}

/** Insert a `---` divider below the cursor's line (or on it, when it is empty). */
export function divider(text: string, sels: Sel[]): EditResult {
  const lines = linesOf(text);
  const line = lines[lineIndexAt(lines, sels[0]?.head ?? 0)];
  const blank = !line.text.trim();
  const insert = (blank ? '' : '\n\n') + '---\n';
  const at = blank ? line.from : line.to;
  return { changes: [{ from: at, to: at, insert }], selections: [{ anchor: at + insert.length, head: at + insert.length }] };
}

/** Align the pipes of the markdown table that contains `pos`. */
export function formatTable(text: string, pos: number): EditResult | undefined {
  const lines = linesOf(text);
  const isRow = (i: number) => i >= 0 && i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i].text);
  let start = lineIndexAt(lines, pos);
  if (!isRow(start)) { return undefined; }
  let end = start;
  while (isRow(start - 1)) { start--; }
  while (isRow(end + 1)) { end++; }

  const rows = lines.slice(start, end + 1).map(l => splitRow(l.text));
  const cols = Math.max(...rows.map(r => r.length));
  const isSep = (r: string[]) => r.every(c => /^:?-+:?$/.test(c));
  const widths = Array.from({ length: cols }, (_, c) => Math.max(3, ...rows.filter(r => !isSep(r)).map(r => (r[c] ?? '').length)));
  const indent = /^\s*/.exec(lines[start].text)![0];
  const out = rows.map(r => indent + (isSep(r)
    ? '| ' + widths.map((w, c) => {
      const cell = r[c] ?? '---';
      return (cell.startsWith(':') ? ':' : '-') + '-'.repeat(w - 2) + (cell.endsWith(':') ? ':' : '-');
    }).join(' | ') + ' |'
    : '| ' + widths.map((w, c) => (r[c] ?? '').padEnd(w)).join(' | ') + ' |'));
  const from = lines[start].from, to = lines[end].to;
  const insert = out.join('\n');
  const keep = Math.min(pos, from + insert.length);
  return { changes: [{ from, to, insert }], selections: [{ anchor: keep, head: keep }] };
}

/** Make a line a heading of `level` (0 = normal text). */
export function setHeadingLine(line: string, level: number): string {
  const body = line.replace(/^#{1,6}\s+/, '');
  return level > 0 ? `${'#'.repeat(level)} ${body}` : body;
}
