// Live editor: an editable, formatted view of a Markdown file. The text stays
// plain Markdown; syntax characters are hidden except on the lines being edited.
import { Annotation, EditorSelection, EditorState, Range, StateEffect, StateField, Transaction, Extension } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, KeyBinding, ViewPlugin, ViewUpdate, WidgetType, drawSelection, dropCursor, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
// Only the language and two commands: markdown() itself would pull in HTML/CSS/JS parsers.
import { deleteMarkupBackward, insertNewlineContinueMarkup, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, Language, LanguageSupport, indentUnit, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';
import type { SyntaxNode } from '@lezer/common';
import type { MarkdownParser } from '@lezer/markdown';
import * as fmt from '../shared/format';
import { countWords, readableText } from '../shared/stats';
import { EXTERNAL, IMAGE, splitWikiTarget } from '../parser';
import { Highlight, Tag, WikiLink } from './markdownExtensions';
import { createToolbar } from './toolbar';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

// ------------------------------------------------------------------ language
// GFM plus ==highlight==, [[wikilinks]] and #tags. Reusing markdownLanguage's data facet
// keeps the list-continuation commands working with this parser.
const markdownSupport = new LanguageSupport(new Language(
  markdownLanguage.data,
  (markdownLanguage.parser as MarkdownParser).configure([Highlight, WikiLink, Tag]),
  [], 'markdown',
));

// ------------------------------------------------------------------ link resolution
interface Resolved { exists: boolean; src?: string; path?: string; }
const resolved = new Map<string, Resolved>();
const pending = new Map<string, { target: string; kind: 'wiki' | 'markdown' }>();
const refresh = StateEffect.define<null>();
let resolveTimer: number | undefined;

/** Cached resolution of a link target; unknown targets are requested from the extension in one batch. */
function lookup(target: string, kind: 'wiki' | 'markdown'): Resolved | undefined {
  const key = kind + '|' + target;
  const r = resolved.get(key);
  if (!r && !pending.has(key)) {
    pending.set(key, { target, kind });
    clearTimeout(resolveTimer);
    resolveTimer = window.setTimeout(() => {
      vscode.postMessage({ type: 'resolve', items: [...pending].map(([k, v]) => ({ key: k, ...v })) });
    }, 30);
  }
  return r;
}

// ------------------------------------------------------------------ widgets
const span = (cls: string, text = '') => { const s = document.createElement('span'); s.className = cls; s.textContent = text; return s; };

class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() { return span('cm-d-bullet', '•'); }
}
const bullet = new BulletWidget();

class HrWidget extends WidgetType {
  eq() { return true; }
  toDOM() { return span('cm-d-hr'); }
}
const hr = new HrWidget();

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) { super(); }
  eq(o: CheckboxWidget) { return o.checked === this.checked && o.pos === this.pos; }
  toDOM(view: EditorView) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-d-checkbox';
    box.checked = this.checked;
    box.addEventListener('mousedown', e => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? ' ' : 'x' } });
    });
    return box;
  }
  ignoreEvent() { return true; }
}

// ------------------------------------------------------------------ images
interface Img { src: string; alt: string; width?: string; height?: string; }

/** Something we can show for an image reference: web/data URLs as they are, files resolved by the extension. */
function imageSrc(raw: string): string | undefined {
  raw = raw.trim();
  if (raw.startsWith('<') && raw.endsWith('>')) { raw = raw.slice(1, -1); }
  if (EXTERNAL.test(raw)) { return /^(https?|data):/i.test(raw) ? raw : undefined; }
  let target = raw.replace(/[?#].*$/, '');
  try { target = decodeURIComponent(target); } catch { /* keep raw */ }
  return target ? lookup(target, 'markdown')?.src : undefined;
}

/** `alt|300` or `alt|300x200` sets the size (Markdown images and embeds). */
function sizedAlt(alt: string): Pick<Img, 'alt' | 'width' | 'height'> {
  const m = /^(.*?)\|\s*(\d+)(?:x(\d+))?\s*$/.exec(alt);
  return m ? { alt: m[1], width: m[2], height: m[3] } : { alt };
}

const IMG_TAG = /<img\b[^>]*>/gi;
function htmlAttr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? m[1] ?? m[2] ?? m[3] : undefined;
}
function htmlImage(tag: string): Img | undefined {
  const src = imageSrc(htmlAttr(tag, 'src') ?? '');
  return src ? { src, alt: htmlAttr(tag, 'alt') ?? '', width: htmlAttr(tag, 'width'), height: htmlAttr(tag, 'height') } : undefined;
}

const cssSize = (v?: string) => (v && /^\d+(\.\d+)?$/.test(v) ? v + 'px' : v);
function imageElement(i: Img): HTMLImageElement {
  const img = document.createElement('img');
  img.className = 'cm-d-image';
  img.src = i.src; img.alt = i.alt; img.title = i.alt;
  if (i.width) { img.style.width = cssSize(i.width)!; }
  if (i.height) { img.style.height = cssSize(i.height)!; }
  return img;
}

/** One image inline, or a row of images on its own line (`align` from HTML such as `<p align="center">`). */
class ImageWidget extends WidgetType {
  constructor(readonly images: Img[], readonly align?: string) { super(); }
  eq(o: ImageWidget) { return o.align === this.align && JSON.stringify(o.images) === JSON.stringify(this.images); }
  toDOM() {
    if (this.align === undefined && this.images.length === 1) { return imageElement(this.images[0]); }
    const row = span('cm-d-image-row');
    row.style.display = 'block';
    if (this.align) { row.style.textAlign = this.align; }
    this.images.forEach(i => row.appendChild(imageElement(i)));
    return row;
  }
}

class CodeInfoWidget extends WidgetType {
  constructor(readonly lang: string) { super(); }
  eq(o: CodeInfoWidget) { return o.lang === this.lang; }
  toDOM() { return span('cm-d-code-lang', this.lang); }
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Small inline renderer for table cells (formatting, wikilinks and images). */
function renderInline(s: string): string {
  // Images first, swapped for placeholders so the formatting rules below cannot touch their URLs.
  const images: string[] = [];
  const keep = (img: Img | undefined, fallback: string) => {
    if (!img) { return fallback; }
    images.push(imageElement(img).outerHTML);
    return `\u0000${images.length - 1}\u0000`;
  };
  s = s
    .replace(/!\[\[([^\]]+)\]\]/g, (m, inner: string) => {
      const w = splitWikiTarget(inner);
      const src = IMAGE.test(w.target) ? lookup(w.target, 'wiki')?.src : undefined;
      return keep(src ? { src, ...sizedAlt(w.target + (w.alias ? '|' + w.alias : '')) } : undefined, m);
    })
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (m, alt: string, raw: string) => {
      const src = imageSrc(raw);
      return keep(src ? { src, ...sizedAlt(alt) } : undefined, m);
    })
    .replace(IMG_TAG, m => keep(htmlImage(m), m));
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/==([^=]+)==/g, '<mark>$1</mark>')
    .replace(/\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
      const w = splitWikiTarget(inner);
      return `<span class="cm-d-link" data-d-target="${esc(w.target)}" data-d-heading="${esc(w.heading ?? '')}" data-d-kind="wiki">${esc(w.alias ?? inner)}</span>`;
    })
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => images[Number(i)]);
}

/** Bumped whenever link resolutions arrive, so tables re-render images that just resolved. */
let resolveRevision = 0;

class TableWidget extends WidgetType {
  constructor(readonly source: string, readonly from: number, readonly revision = resolveRevision) { super(); }
  eq(o: TableWidget) { return o.source === this.source && o.from === this.from && o.revision === this.revision; }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div');
    wrap.className = 'cm-d-table-wrap';
    const table = document.createElement('table');
    const rows = this.source.split('\n').filter(r => r.trim());
    const align = fmt.splitRow(rows[1] ?? '').map(c => c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : 'left');
    rows.forEach((r, i) => {
      if (i === 1) { return; }
      const tr = document.createElement('tr');
      fmt.splitRow(r).forEach((cell, c) => {
        const td = document.createElement(i === 0 ? 'th' : 'td');
        td.style.textAlign = align[c] ?? 'left';
        td.innerHTML = renderInline(cell);
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
    wrap.appendChild(table);
    wrap.addEventListener('mousedown', e => {
      e.preventDefault();
      const link = (e.target as HTMLElement).closest('[data-d-target]') as HTMLElement | null;
      if (link) { openLink(link, e); return; }
      view.dispatch({ selection: { anchor: this.from } });
      view.focus();
    });
    return wrap;
  }
  ignoreEvent() { return true; }
}

// ------------------------------------------------------------------ inline decorations
const hide = Decoration.replace({});
const markCache = new Map<string, Decoration>();
const mark = (cls: string, attrs?: Record<string, string>) => {
  if (attrs) { return Decoration.mark({ class: cls, attributes: attrs }); }
  let d = markCache.get(cls);
  if (!d) { d = Decoration.mark({ class: cls }); markCache.set(cls, d); }
  return d;
};
const lineCache = new Map<string, Decoration>();
const lineDeco = (cls: string) => {
  let d = lineCache.get(cls);
  if (!d) { d = Decoration.line({ class: cls }); lineCache.set(cls, d); }
  return d;
};
const SIMPLE_MARKS: Record<string, string> = {
  Emphasis: 'cm-d-em', StrongEmphasis: 'cm-d-strong', Strikethrough: 'cm-d-strike',
  Highlight: 'cm-d-highlight', InlineCode: 'cm-d-code', Tag: 'cm-d-tag',
};

const HEADING_NODE = /^(ATX|Setext)Heading\d$/;
const TASK_LINE = /^\s*([-*+]|\d+[.)])\s+\[[ xX]\]/;

/** Lines touched by a selection, while the editor has focus (their syntax stays visible). */
function activeLines(view: EditorView): Set<number> {
  const set = new Set<number>();
  if (!view.hasFocus) { return set; }
  for (const r of view.state.selection.ranges) {
    for (let l = view.state.doc.lineAt(r.from).number, b = view.state.doc.lineAt(r.to).number; l <= b; l++) { set.add(l); }
  }
  return set;
}

/** What the inline decorations depend on besides the document: active lines, and the cursor on task lines. */
function activeKey(view: EditorView, active: Set<number>): string {
  let key = [...active].join(',');
  for (const r of view.state.selection.ranges) {
    if (active.size && TASK_LINE.test(view.state.doc.lineAt(r.head).text)) { key += ':' + r.head; }
  }
  return key;
}

function buildInline(view: EditorView, active: Set<number>): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const isActive = (from: number, to: number) => {
    for (let l = doc.lineAt(from).number, b = doc.lineAt(to).number; l <= b; l++) { if (active.has(l)) { return true; } }
    return false;
  };
  const out: Range<Decoration>[] = [];
  const linesDone = new Set<string>();
  const addLine = (pos: number, cls: string) => {
    const from = doc.lineAt(pos).from;
    const key = from + cls;
    if (!linesDone.has(key)) { linesDone.add(key); out.push(lineDeco(cls).range(from)); }
  };
  // Decorations from a view plugin may not hide line breaks.
  const sameLine = (from: number, to: number) => doc.lineAt(from).number === doc.lineAt(to).number;
  const hideMark = (from: number, to: number, withSpace = false) => {
    if (withSpace && doc.sliceString(to, to + 1) === ' ') { to++; }
    if (to > from && sameLine(from, to)) { out.push(hide.range(from, to)); }
  };
  const replaceWith = (widget: WidgetType, from: number, to: number) => {
    if (sameLine(from, to)) { out.push(Decoration.replace({ widget }).range(from, to)); }
  };

  const linkDecorations = (node: SyntaxNode, act: boolean) => {
    const marks = node.getChildren('LinkMark');
    if (marks.length < 2) { return; }
    const url = node.getChild('URL');
    const textFrom = marks[0].to, textTo = marks[1].from;
    let href = url ? doc.sliceString(url.from, url.to) : '';
    if (href.startsWith('<')) { href = href.slice(1, -1); }
    let attrs: Record<string, string>;
    if (EXTERNAL.test(href)) {
      attrs = { 'data-d-href': href };
    } else {
      const hash = href.indexOf('#');
      let target = hash >= 0 ? href.slice(0, hash) : href;
      try { target = decodeURIComponent(target); } catch { /* keep raw */ }
      const r = target ? lookup(target, 'markdown') : undefined;
      attrs = { 'data-d-target': target, 'data-d-heading': hash >= 0 ? href.slice(hash + 1) : '', 'data-d-kind': 'markdown' };
      if (r && !r.exists) { attrs['data-d-missing'] = '1'; }
    }
    if (textTo > textFrom) { out.push(mark('cm-d-link' + (act ? '' : ' cm-d-rendered') + (attrs['data-d-missing'] ? ' cm-d-missing' : ''), attrs).range(textFrom, textTo)); }
    if (!act) {
      hideMark(node.from, textFrom); hideMark(textTo, node.to);
      // Linked images, e.g. badges: [![build](badge.svg)](https://…)
      for (const img of node.getChildren('Image')) { imageDecoration(img); }
    }
  };

  const imageDecoration = (node: SyntaxNode) => {
    const url = node.getChild('URL');
    const src = url && imageSrc(doc.sliceString(url.from, url.to));
    if (!src) { return; }
    const marks = node.getChildren('LinkMark');
    const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : '';
    replaceWith(new ImageWidget([{ src, ...sizedAlt(alt) }]), node.from, node.to);
  };

  /** HTML blocks: lines with <img> tags become the images; lines that are only tags are hidden. */
  const htmlBlock = (node: SyntaxNode) => {
    const align = /\balign\s*=\s*["']?(center|right|left)/i.exec(doc.sliceString(node.from, Math.min(node.to, node.from + 200)))?.[1];
    for (let p = node.from; p <= node.to;) {
      const l = doc.lineAt(p);
      p = l.to + 1;
      if (active.has(l.number)) { continue; }
      const images = [...l.text.matchAll(IMG_TAG)].map(m => htmlImage(m[0])).filter((i): i is Img => !!i);
      if (images.length) { replaceWith(new ImageWidget(images, align ?? 'left'), l.from, l.to); }
      else if (/^\s*(<\/?[a-z][^>]*>\s*)+$/i.test(l.text)) { hideMark(l.from, l.to); }
    }
  };

  const wikiDecorations = (node: SyntaxNode, act: boolean) => {
    const embed = node.name === 'WikiEmbed';
    const open = embed ? 3 : 2;
    const w = splitWikiTarget(doc.sliceString(node.from + open, node.to - 2));
    const r = w.target ? lookup(w.target, 'wiki') : { exists: true };
    if (embed && !act && r?.src && IMAGE.test(w.target)) {
      replaceWith(new ImageWidget([{ src: r.src, ...sizedAlt(w.target + (w.alias ? '|' + w.alias : '')) }]), node.from, node.to);
      return;
    }
    const textFrom = node.from + open + (act ? 0 : w.aliasOffset);
    const textTo = node.to - 2;
    const cls = 'cm-d-link' + (act ? '' : ' cm-d-rendered') + (r && !r.exists ? ' cm-d-missing' : '') + (embed ? ' cm-d-embed' : '');
    if (textTo > textFrom) {
      out.push(mark(cls, { 'data-d-target': w.target, 'data-d-heading': w.heading ?? '', 'data-d-kind': 'wiki', title: r?.path ?? (r && !r.exists ? 'Not created yet' : '') }).range(textFrom, textTo));
    }
    if (!act) { hideMark(node.from, textFrom); hideMark(textTo, node.to); }
    else { out.push(mark('cm-d-faint').range(node.from, node.from + open), mark('cm-d-faint').range(node.to - 2, node.to)); }
  };

  const tree = syntaxTree(state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from, to,
      enter: ({ node }) => {
        const name = node.name;
        const simple = SIMPLE_MARKS[name];
        if (simple) { out.push(mark(simple).range(node.from, node.to)); return; }
        if (HEADING_NODE.test(name)) { addLine(node.from, `cm-d-h cm-d-h${name.slice(-1)}`); return; }
        const act = isActive(node.from, node.to);

        switch (name) {
          case 'HeaderMark':
            if (!act) {
              if (node.parent?.name.startsWith('ATX')) { hideMark(node.from, node.to, true); }
              else { out.push(mark('cm-d-faint').range(node.from, node.to)); }
            }
            return;
          case 'EmphasisMark': case 'StrikethroughMark': case 'HighlightMark':
            if (!act) { hideMark(node.from, node.to); }
            return;
          case 'CodeMark':
            if (!act && node.parent?.name === 'InlineCode') { hideMark(node.from, node.to); }
            return;
          case 'Blockquote':
            for (let p = node.from; p <= node.to;) { const l = doc.lineAt(p); addLine(l.from, 'cm-d-quote'); p = l.to + 1; }
            return;
          case 'QuoteMark': if (!act) { hideMark(node.from, node.to, true); } return;
          case 'ListMark': {
            const item = node.parent;
            if (item?.getChild('Task')) { if (!act) { hideMark(node.from, node.to, true); } return; }
            if (item?.parent?.name === 'BulletList' && !act) { replaceWith(bullet, node.from, node.to); }
            else { out.push(mark('cm-d-listmark').range(node.from, node.to)); }
            return;
          }
          case 'TaskMarker': {
            const checked = /x/i.test(doc.sliceString(node.from, node.to));
            const cursorIn = view.hasFocus && state.selection.ranges.some(r => r.from <= node.to && r.to >= node.from);
            if (!cursorIn) { replaceWith(new CheckboxWidget(checked, node.from), node.from, node.to); }
            if (checked) { addLine(node.from, 'cm-d-task-done'); }
            return;
          }
          case 'HorizontalRule':
            if (!act) { replaceWith(hr, node.from, node.to); }
            return;
          case 'FencedCode': {
            const firstLine = doc.lineAt(node.from), lastLine = doc.lineAt(node.to);
            for (let p = node.from; p <= node.to;) {
              const l = doc.lineAt(p);
              const first = l.from === firstLine.from, last = l.from === lastLine.from;
              addLine(l.from, 'cm-d-codeblock' + (first ? ' cm-d-codeblock-first' : '') + (last ? ' cm-d-codeblock-last' : ''));
              if (!act && first) {
                const info = node.getChild('CodeInfo');
                replaceWith(new CodeInfoWidget(info ? doc.sliceString(info.from, info.to) : ''), l.from, l.to);
              } else if (!act && last && !first && /^\s*(`{3,}|~{3,})\s*$/.test(l.text)) {
                hideMark(l.from, l.to);
              }
              p = l.to + 1;
            }
            return false;
          }
          case 'Link': linkDecorations(node, act); return false;
          case 'Image': if (!act) { imageDecoration(node); } return false;
          case 'HTMLBlock': htmlBlock(node); return false;
          case 'HTMLTag': {
            if (act) { return; }
            const tag = doc.sliceString(node.from, node.to);
            const img = /^<img\b/i.test(tag) ? htmlImage(tag) : undefined;
            if (img) { replaceWith(new ImageWidget([img]), node.from, node.to); }
            return;
          }
          case 'WikiLink': case 'WikiEmbed': wikiDecorations(node, act); return false;
          case 'URL':
            if (node.parent?.name !== 'Link' && node.parent?.name !== 'Image') {
              out.push(mark('cm-d-link cm-d-rendered', { 'data-d-href': doc.sliceString(node.from, node.to) }).range(node.from, node.to));
            }
            return;
        }
        return;
      },
    });
  }
  return Decoration.set(out, true);
}

const inlinePlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  private activeKey: string;
  constructor(view: EditorView) {
    const active = activeLines(view);
    this.activeKey = activeKey(view, active);
    this.decorations = buildInline(view, active);
  }
  update(u: ViewUpdate) {
    const active = activeLines(u.view);
    const key = activeKey(u.view, active);
    // Moving the cursor within the same line(s) changes nothing visible: skip the rebuild.
    if (u.docChanged || u.viewportChanged || key !== this.activeKey || syntaxTree(u.startState) !== syntaxTree(u.state)
      || u.transactions.some(tr => tr.effects.some(e => e.is(refresh)))
      || (u.selectionSet && u.state.selection.ranges.some(r => !r.empty))) {
      this.activeKey = key;
      this.decorations = buildInline(u.view, active);
    }
  }
}, { decorations: v => v.decorations });

// ------------------------------------------------------------------ tables (block widgets need a state field)
const focusEffect = StateEffect.define<boolean>();
const focusField = StateField.define<boolean>({
  create: () => false,
  update: (v, tr) => tr.effects.reduce((acc, e) => e.is(focusEffect) ? e.value : acc, v),
});

interface Tables { ranges: { from: number; to: number }[]; editing: string; deco: DecorationSet; }

function tableRanges(state: EditorState): Tables['ranges'] {
  const out: Tables['ranges'] = [];
  syntaxTree(state).iterate({
    enter: ({ name, from, to }) => {
      if (name === 'Table') { out.push({ from: state.doc.lineAt(from).from, to: state.doc.lineAt(to).to }); return false; }
      // Tables only live at the top level or inside quotes and lists.
      return name === 'Document' || name === 'Blockquote' || name === 'ListItem' || name.endsWith('List');
    },
  });
  return out;
}

/** Which tables hold the cursor (those are shown as Markdown so they can be edited). */
function editingKey(state: EditorState, ranges: Tables['ranges']): string {
  if (!state.field(focusField)) { return ''; }
  return ranges.map((t, i) => state.selection.ranges.some(r => r.from <= t.to && r.to >= t.from) ? i : -1).filter(i => i >= 0).join(',');
}

function tableDecorations(state: EditorState, ranges: Tables['ranges'], editing: string): DecorationSet {
  const skip = new Set(editing ? editing.split(',').map(Number) : []);
  return Decoration.set(ranges.filter((_, i) => !skip.has(i)).map(t =>
    Decoration.replace({ widget: new TableWidget(state.doc.sliceString(t.from, t.to), t.from), block: true }).range(t.from, t.to)));
}

const tableField = StateField.define<Tables>({
  create(state) {
    const ranges = tableRanges(state);
    const editing = editingKey(state, ranges);
    return { ranges, editing, deco: tableDecorations(state, ranges, editing) };
  },
  update(value, tr) {
    const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    const refreshed = tr.effects.some(e => e.is(refresh)); // images in cells may have resolved
    if (!tr.docChanged && !treeChanged && !tr.selection && !refreshed && !tr.effects.some(e => e.is(focusEffect))) { return value; }
    const ranges = tr.docChanged || treeChanged ? tableRanges(tr.state) : value.ranges;
    const editing = editingKey(tr.state, ranges);
    if (!refreshed && ranges === value.ranges && editing === value.editing) { return value; }
    return { ranges, editing, deco: tableDecorations(tr.state, ranges, editing) };
  },
  provide: f => EditorView.decorations.from(f, v => v.deco),
});

// ------------------------------------------------------------------ theme
const highlight = HighlightStyle.define([
  { tag: t.monospace, fontFamily: 'var(--vscode-editor-font-family)' },
  { tag: t.url, color: 'var(--vscode-textLink-foreground)' },
  { tag: [t.processingInstruction, t.meta, t.comment], color: 'var(--vscode-descriptionForeground)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--vscode-editor-foreground)', backgroundColor: 'var(--vscode-editor-background)' },
  '.cm-scroller': { fontFamily: 'var(--diamond-font, var(--vscode-font-family))', fontSize: 'var(--diamond-font-size, 15px)', lineHeight: '1.65' },
  '.cm-content': { padding: '32px 0 40vh', caretColor: 'var(--vscode-editorCursor-foreground)' },
  '.cm-line': { padding: '0 48px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--vscode-editorCursor-foreground)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--vscode-editor-selectionBackground) !important' },
  '.cm-panels': { backgroundColor: 'var(--vscode-editorWidget-background)', color: 'var(--vscode-editorWidget-foreground)' },
  '.cm-searchMatch': { backgroundColor: 'var(--vscode-editor-findMatchHighlightBackground)' },
});

// ------------------------------------------------------------------ links and events
function openLink(el: HTMLElement, e: MouseEvent) {
  const href = el.getAttribute('data-d-href');
  vscode.postMessage(href
    ? { type: 'openExternal', href }
    : { type: 'open', target: el.getAttribute('data-d-target') ?? '', heading: el.getAttribute('data-d-heading') || undefined, kind: el.getAttribute('data-d-kind') ?? 'wiki', beside: e.altKey });
}

const events = EditorView.domEventHandlers({
  mousedown(e) {
    const el = (e.target as HTMLElement).closest('.cm-d-link') as HTMLElement | null;
    if (!el || e.button !== 0) { return false; }
    // Rendered links open on click; while editing a line use Ctrl/Cmd+Click.
    if (el.classList.contains('cm-d-rendered') || e.ctrlKey || e.metaKey) {
      e.preventDefault();
      openLink(el, e);
      return true;
    }
    return false;
  },
  keydown(e) {
    // Undo / redo belong to this editor; stop VS Code from also running its own undo.
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) { e.stopPropagation(); }
    return false;
  },
  focus(_e, view) { setTimeout(() => view.dispatch({ effects: focusEffect.of(true) })); return false; },
  blur(_e, view) { setTimeout(() => { if (!view.hasFocus) { view.dispatch({ effects: focusEffect.of(false) }); } }); return false; },
});

// ------------------------------------------------------------------ keymaps
/** Shortcuts handled by VS Code keybindings (they reach us as `format` messages). */
const RESERVED = new Set(['mod-b', 'mod-i', 'mod-e', 'mod-l', 'mod-shift-k', 'mod-shift-x', 'mod-shift-h', 'mod-shift-8', 'mod-shift-7', 'mod-shift-]', 'alt-mod-l', 'alt-mod-g']);
const notReserved = (b: KeyBinding) => {
  if (!b.key) { return true; }
  const parts = b.key.toLowerCase().split('-').map(p => p === 'ctrl' || p === 'cmd' || p === 'meta' ? 'mod' : p);
  const key = parts.pop()!;
  return !RESERVED.has([...parts.sort(), key].join('-'));
};

// ------------------------------------------------------------------ sync with the extension
const External = Annotation.define<boolean>();
/** Sequence number of the last full text from the extension (echoed with edits). */
let seq = 0;

const syncOut = EditorView.updateListener.of(u => {
  if (!u.docChanged || u.transactions.some(tr => tr.annotation(External))) { return; }
  const doc = u.startState.doc;
  const changes: { fl: number; fc: number; tl: number; tc: number; insert: string }[] = [];
  u.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const a = doc.lineAt(fromA), b = doc.lineAt(toA);
    changes.push({ fl: a.number - 1, fc: fromA - a.from, tl: b.number - 1, tc: toA - b.from, insert: inserted.toString() });
  });
  vscode.postMessage({ type: 'edit', seq, changes });
});

let selectionTimer: number | undefined;
const reportSelection = EditorView.updateListener.of(u => {
  if (!u.selectionSet && !u.docChanged && !u.focusChanged) { return; }
  toolbar?.update(u.view);
  clearTimeout(selectionTimer);
  selectionTimer = window.setTimeout(() => {
    const { state } = u.view;
    const main = state.selection.main;
    const line = state.doc.lineAt(main.head);
    const selected = state.selection.ranges.filter(r => !r.empty).map(r => state.sliceDoc(r.from, r.to)).join('\n');
    const readable = selected ? readableText(selected) : '';
    vscode.postMessage({ type: 'selection', selection: { line: line.number, col: main.head - line.from + 1, selWords: readable ? countWords(readable) : 0, selChars: readable.replace(/\n/g, '').length } });
  }, 80);
});

function applyResult(view: EditorView, r: fmt.EditResult | undefined) {
  if (!r) { return; }
  view.dispatch({
    changes: r.changes,
    selection: EditorSelection.create(r.selections.map(s => EditorSelection.range(s.anchor, s.head))),
    userEvent: 'input.format',
    scrollIntoView: true,
  });
  view.focus();
}

function handleFormat(view: EditorView, msg: any) {
  const { state } = view;
  const text = state.doc.toString();
  const sels = state.selection.ranges.map(r => ({ anchor: r.anchor, head: r.head }));
  switch (msg.op) {
    case 'wrap': return applyResult(view, fmt.toggleWrap(text, sels, fmt.WRAP_OPS[msg.which as fmt.WrapOp]));
    case 'line': return applyResult(view, fmt.transformLines(text, sels, fmt.LINE_OPS[msg.which as fmt.LineOp]));
    case 'heading': return applyResult(view, fmt.transformLines(text, sels, l => fmt.setHeadingLine(l, msg.level)));
    case 'codeBlock': return applyResult(view, fmt.codeBlock(text, sels, msg.lang));
    case 'insert': return applyResult(view, fmt.insertText(sels, msg.text, msg.selFrom, msg.selTo));
    case 'formatTable': return applyResult(view, fmt.formatTable(text, sels[0].head));
    case 'divider': return applyResult(view, fmt.divider(text, sels));
    case 'link': {
      const main = state.selection.main;
      const selected = state.sliceDoc(main.from, main.to);
      return applyResult(view, fmt.insertText(sels, `[[${msg.target}${selected ? '|' + selected : ''}]]`));
    }
  }
}

/** Replace the document with `text`, touching only the part that differs so the cursor stays put. */
function replaceText(view: EditorView, text: string) {
  const old = view.state.doc.toString();
  if (old === text) { return; }
  let start = 0;
  while (start < old.length && start < text.length && old.charCodeAt(start) === text.charCodeAt(start)) { start++; }
  let endOld = old.length, endNew = text.length;
  while (endOld > start && endNew > start && old.charCodeAt(endOld - 1) === text.charCodeAt(endNew - 1)) { endOld--; endNew--; }
  view.dispatch({
    changes: { from: start, to: endOld, insert: text.slice(start, endNew) },
    annotations: [External.of(true), Transaction.addToHistory.of(false)],
  });
}

// ------------------------------------------------------------------ boot
let view: EditorView | undefined;
let toolbar: ReturnType<typeof createToolbar> | undefined;

function createEditor(text: string, settings: { toolbar?: boolean; readableLineLength?: boolean; fontSize?: number; fontFamily?: string; }) {
  const body = document.body;
  body.classList.toggle('readable', settings.readableLineLength !== false);
  body.style.setProperty('--diamond-font-size', settings.fontSize ? settings.fontSize + 'px' : null);
  body.style.setProperty('--diamond-font', settings.fontFamily || null);
  toolbar?.element.remove();
  toolbar = settings.toolbar === false ? undefined : createToolbar({
    format: handleFormat,
    command: id => vscode.postMessage({ type: 'command', id }),
  }, () => view);
  if (toolbar) { body.insertBefore(toolbar.element, document.getElementById('editor')); }

  const extensions: Extension[] = [
    history(),
    drawSelection(),
    dropCursor(),
    EditorView.lineWrapping,
    indentUnit.of('    '),
    markdownSupport,
    syntaxHighlighting(highlight),
    search({ top: true }),
    keymap.of([
      { key: 'Enter', run: insertNewlineContinueMarkup },
      { key: 'Backspace', run: deleteMarkupBackward },
      indentWithTab,
      ...defaultKeymap.filter(notReserved), ...historyKeymap, ...searchKeymap.filter(notReserved),
    ]),
    focusField,
    inlinePlugin,
    tableField,
    events,
    syncOut,
    reportSelection,
    theme,
  ];
  const created = new EditorView({ state: EditorState.create({ doc: text, extensions }), parent: document.getElementById('editor')! });
  toolbar?.update(created);
  return created;
}

function reveal(lineNo: number) {
  if (!view) { return; }
  const line = view.state.doc.line(Math.min(view.state.doc.lines, Math.max(1, lineNo + 1)));
  view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 40 }) });
  view.focus();
}

window.addEventListener('message', ev => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init':
      seq = msg.seq;
      view?.destroy();
      view = createEditor(msg.text, msg.settings ?? {});
      if (msg.reveal !== undefined) { reveal(msg.reveal); } else { view.focus(); }
      break;
    case 'update':
      seq = msg.seq;
      if (view) { replaceText(view, msg.text); }
      break;
    case 'format': if (view) { handleFormat(view, msg.format); } break;
    case 'resolved':
      for (const [k, v] of Object.entries(msg.items as Record<string, Resolved>)) { resolved.set(k, v); pending.delete(k); }
      resolveRevision++;
      view?.dispatch({ effects: refresh.of(null) });
      break;
    case 'invalidate':
      resolved.clear(); pending.clear();
      resolveRevision++;
      view?.dispatch({ effects: refresh.of(null) });
      break;
    case 'reveal': reveal(msg.line); break;
    case 'probe':
      // Used by the integration tests: which images are on screen, and did they load?
      vscode.postMessage({ type: 'probeResult', images: [...document.querySelectorAll<HTMLImageElement>('img.cm-d-image')].map(i => ({ alt: i.alt, loaded: i.complete && i.naturalWidth > 0 })) });
      break;
  }
});

vscode.postMessage({ type: 'ready' });
