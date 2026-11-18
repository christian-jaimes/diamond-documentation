// Squiggly underlines for diagnostics other extensions report (e.g. Code Spell Checker), with a hover
// card that lists the message and quick fixes (suggestions, "add to dictionary", …). The extension
// side is src/diagnostics.ts; ranges are line/column and move with the text while it is edited.
import { EditorState, Range, StateEffect, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, Tooltip, hoverTooltip } from '@codemirror/view';

interface DiagItem { sl: number; sc: number; el: number; ec: number; message: string; severity: number; source?: string; }
interface Fix { title: string; preferred: boolean; }
type Post = (msg: unknown) => void;
let post: Post = () => {};

const setDiagnostics = StateEffect.define<DecorationSet>();
const SEVERITY = ['error', 'warning', 'info', 'hint'];

const diagnosticField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) { if (e.is(setDiagnostics)) { value = e.value; } }
    return value;
  },
  provide: f => EditorView.decorations.from(f),
});

function toPos(state: EditorState, line: number, col: number): number {
  const l = state.doc.line(Math.min(state.doc.lines, Math.max(1, line + 1)));
  return Math.min(l.to, l.from + col);
}

/** Replace the underlines with `items` (called when the extension sends fresh diagnostics). */
function applyDiagnostics(view: EditorView, items: DiagItem[]) {
  const ranges: Range<Decoration>[] = [];
  for (const d of items) {
    const from = toPos(view.state, d.sl, d.sc), to = toPos(view.state, d.el, d.ec);
    if (to <= from) { continue; }
    const sev = SEVERITY[Math.max(0, Math.min(3, d.severity))];
    ranges.push(Decoration.mark({ class: `cm-d-diag cm-d-diag-${sev}`, diag: d }).range(from, to));
  }
  view.dispatch({ effects: setDiagnostics.of(Decoration.set(ranges, true)) });
  post({ type: 'diagnosticsShown', count: ranges.length });
}

// ---------------------------------------------------------------- quick fixes
let fixId = 0;
const fixWaiting = new Map<number, (f: Fix[]) => void>();

/** Handles the extension's diagnostics messages; returns true when the message was one of ours. */
export function handleDiagnosticMessage(view: EditorView | undefined, msg: any): boolean {
  switch (msg.type) {
    case 'diagnostics': if (view) { applyDiagnostics(view, msg.items ?? []); } return true;
    case 'quickFixes': fixWaiting.get(msg.id)?.(msg.actions ?? []); fixWaiting.delete(msg.id); return true;
  }
  return false;
}

function requestFixes(d: DiagItem): { id: number; fixes: Promise<Fix[]> } {
  const id = ++fixId;
  const fixes = new Promise<Fix[]>(resolve => {
    fixWaiting.set(id, resolve);
    post({ type: 'quickFixes', id, sl: d.sl, sc: d.sc, el: d.el, ec: d.ec });
    setTimeout(() => { if (fixWaiting.delete(id)) { resolve([]); } }, 2500);
  });
  return { id, fixes };
}

function diagnosticAt(view: EditorView, pos: number): { from: number; to: number; diag: DiagItem } | undefined {
  let found: { from: number; to: number; diag: DiagItem } | undefined;
  view.state.field(diagnosticField).between(pos, pos, (from, to, deco) => {
    if (!found && pos >= from && pos <= to) { found = { from, to, diag: deco.spec.diag }; }
  });
  return found;
}

const hover = hoverTooltip(async (view, pos): Promise<Tooltip | null> => {
  const hit = diagnosticAt(view, pos);
  if (!hit) { return null; }
  // Positions of the (possibly edited) range, as the extension expects them.
  const a = view.state.doc.lineAt(hit.from), b = view.state.doc.lineAt(hit.to);
  const live: DiagItem = { ...hit.diag, sl: a.number - 1, sc: hit.from - a.from, el: b.number - 1, ec: hit.to - b.from };
  const { id, fixes } = requestFixes(live);
  const list = await fixes;
  return {
    pos: hit.from,
    end: hit.to,
    above: true,
    create() {
      const dom = document.createElement('div');
      dom.className = 'cm-d-diag-tip';
      const msg = document.createElement('div');
      msg.className = 'cm-d-diag-msg';
      msg.textContent = hit.diag.message;
      dom.append(msg);
      if (hit.diag.source) {
        const src = document.createElement('div');
        src.className = 'cm-d-diag-src';
        src.textContent = hit.diag.source;
        dom.append(src);
      }
      if (list.length) {
        const menu = document.createElement('div');
        menu.className = 'cm-d-diag-fixes';
        const head = document.createElement('div');
        head.className = 'cm-d-diag-head';
        head.textContent = 'Quick Fix';
        menu.append(head);
        list.forEach((fix, index) => {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = 'cm-d-diag-fix';
          item.textContent = fix.title;
          // mousedown (not click) so the editor keeps focus and the tooltip doesn't vanish first.
          item.addEventListener('mousedown', ev => {
            ev.preventDefault();
            post({ type: 'applyQuickFix', id, index });
            dom.remove();
            view.focus();
          });
          menu.append(item);
        });
        dom.append(menu);
      }
      return { dom };
    },
  };
}, { hideOnChange: true, hoverTime: 250 });

/** Underlined ranges (document offsets, ascending) with their severity index: 0 error … 3 hint. */
export function diagnosticMarks(state: EditorState): { from: number; to: number; severity: number }[] {
  const out: { from: number; to: number; severity: number }[] = [];
  const cursor = state.field(diagnosticField).iter();
  for (; cursor.value; cursor.next()) { out.push({ from: cursor.from, to: cursor.to, severity: Math.max(0, Math.min(3, cursor.value.spec.diag.severity)) }); }
  return out;
}

export function diagnosticsSupport(send: Post) {
  post = send;
  return [diagnosticField, hover];
}
