// [[wikilink]] autocomplete for the live editor: file names after `[[`, headings after `[[file#`.
// Files and headings come from the extension's LinkIndex (see the `linkFiles` / `linkHeadings`
// messages in src/liveEditor.ts); the file list is cached here so typing filters it instantly.
import { Completion, CompletionContext, CompletionResult, autocompletion } from '@codemirror/autocomplete';
import { EditorSelection, Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { FileEntry, rankFiles, wikiContext } from '../shared/wikiComplete';

type Post = (msg: unknown) => void;
let post: Post = () => {};

// ---------------------------------------------------------------- data from the extension
let files: FileEntry[] | undefined;
let filesWaiting: ((f: FileEntry[]) => void)[] = [];
const headingWaiting = new Map<number, (h: { text: string; level: number }[]) => void>();
let headingId = 0;

function getFiles(): FileEntry[] | Promise<FileEntry[]> {
  if (files) { return files; }
  return new Promise(resolve => {
    if (!filesWaiting.length) { post({ type: 'linkFiles' }); }
    filesWaiting.push(resolve);
    setTimeout(() => resolve([]), 3000);
  });
}

function getHeadings(target: string) {
  return new Promise<{ text: string; level: number }[]>(resolve => {
    const id = ++headingId;
    headingWaiting.set(id, resolve);
    post({ type: 'linkHeadings', id, target });
    setTimeout(() => { if (headingWaiting.delete(id)) { resolve([]); } }, 2000);
  });
}

/** Handles the extension's replies; returns true when the message was one of ours. */
export function handleLinkMessage(msg: any): boolean {
  switch (msg.type) {
    case 'linkFiles':
      files = msg.files;
      filesWaiting.splice(0).forEach(r => r(files!));
      return true;
    case 'linkHeadings':
      headingWaiting.get(msg.id)?.(msg.headings);
      headingWaiting.delete(msg.id);
      return true;
    case 'invalidate':
      files = undefined; // files came or went: ask again on next use
      return false; // other handlers (link resolution) need it too
  }
  return false;
}

/** Warm the cache so the first `[[` shows results immediately. */
export function prefetchLinkFiles() { if (!files) { void getFiles(); } }

// ---------------------------------------------------------------- completion
const matchRanges = new WeakMap<Completion, number[]>();

/** Offsets of consecutive matched characters → the [from, to, from, to…] pairs CodeMirror highlights. */
function toPairs(offsets: number[]): number[] {
  const out: number[] = [];
  for (const o of offsets) {
    if (out.length && out[out.length - 1] === o) { out[out.length - 1] = o + 1; } else { out.push(o, o + 1); }
  }
  return out;
}

const inCode = (ctx: CompletionContext) => {
  for (let n: { name: string; parent: any } | null = syntaxTree(ctx.state).resolveInner(ctx.pos, -1); n; n = n.parent) {
    if (n.name === 'FencedCode' || n.name === 'CodeBlock' || n.name === 'InlineCode') { return true; }
  }
  return false;
};

/**
 * Inserts `text` over [from, to) and finishes the link: adds `]]` unless the link is already closed
 * (for instance by auto-closing). `stay` leaves the cursor before the `]]` so `#` or `|` can follow.
 */
function finish(view: EditorView, from: number, to: number, text: string, stay: boolean) {
  const line = view.state.doc.lineAt(to);
  const after = view.state.sliceDoc(to, line.to);
  const closed = /^[^\[\]]*\]\]/.test(after); // the link already ends somewhere ahead
  const nextClose = after.startsWith(']]');
  const insert = text + (closed ? '' : ']]');
  let cursor = from + text.length;
  if (!stay) { cursor += closed ? (nextClose ? 2 : 0) : 2; }
  view.dispatch({
    changes: { from, to, insert },
    selection: EditorSelection.cursor(cursor),
    userEvent: 'input.complete',
  });
}

function fileOption(r: ReturnType<typeof rankFiles>[number]): Completion {
  const { entry, matched } = r;
  const option: Completion = {
    label: entry.text,
    detail: entry.path !== entry.text && entry.path !== entry.text + '.md' ? entry.path : undefined,
    type: entry.md ? 'file' : 'other',
    apply: (view, _c, from, to) => finish(view, from, to, entry.text, entry.md),
  };
  matchRanges.set(option, toPairs(matched));
  return option;
}

function source(ctx: CompletionContext): CompletionResult | Promise<CompletionResult | null> | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const wiki = wikiContext(ctx.state.sliceDoc(line.from, ctx.pos));
  if (!wiki || inCode(ctx)) { return null; }
  const from = ctx.pos - wiki.typed;

  if (wiki.kind === 'file') {
    const build = (all: FileEntry[]): CompletionResult | null => {
      const ranked = rankFiles(all, wiki.query);
      return ranked.length ? { from, options: ranked.map(fileOption), filter: false, getMatch: c => matchRanges.get(c) ?? [] } : null;
    };
    const all = getFiles();
    return Array.isArray(all) ? build(all) : all.then(build);
  }

  return getHeadings(wiki.target).then(headings => {
    if (!headings.length) { return null; }
    return {
      from,
      // Filtered by CodeMirror from here on, so typing narrows the list without asking the extension again.
      validFor: /^[^\[\]|#\n]*$/,
      options: headings.map((h, i): Completion => {
        const text = h.text.replace(/[\[\]|]/g, '');
        return {
          label: text,
          detail: 'H' + h.level,
          type: 'heading',
          boost: -i / 1000, // keep document order among equal matches
          apply: (view, _c, f, t) => finish(view, f, t, text, false),
        };
      }),
    };
  });
}

/** Typing `]` just before the `]]` that ends the link steps over it (needed after completing a file name). */
const stepOverClose = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== ']' || from !== to || view.state.sliceDoc(to, to + 2) !== ']]') { return false; }
  const line = view.state.doc.lineAt(from);
  if (!/\[\[[^\[\]\n]*$/.test(view.state.sliceDoc(line.from, from))) { return false; }
  view.dispatch({ selection: EditorSelection.cursor(from + 1), userEvent: 'input.type' });
  return true;
});

export function linkCompletion(postMessage: Post): Extension {
  post = postMessage;
  return [
    autocompletion({
      override: [source],
      icons: false,
      closeOnBlur: true,
      maxRenderedOptions: 60,
      tooltipClass: () => 'cm-d-complete',
    }),
    stepOverClose,
  ];
}
