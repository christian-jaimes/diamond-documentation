// A find/replace widget that looks and behaves like VS Code's own (Ctrl+F): a floating
// overlay with inline match-case / whole-word / regex toggles, an "N of M" counter,
// previous/next, find-in-selection and a collapsible replace row. It plugs into
// @codemirror/search, which still does the matching and the match highlighting.
import { EditorSelection, EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, KeyBinding, Panel, ViewUpdate } from '@codemirror/view';
import { SearchQuery, closeSearchPanel, getSearchQuery, openSearchPanel, search, searchPanelOpen, setSearchQuery } from '@codemirror/search';
import { ICONS } from './icons';

const MAX_COUNT = 10000;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

// "Find in selection": the range being searched, kept as a decoration so it stays highlighted.
const setScope = StateEffect.define<{ from: number; to: number } | null>();
const scopeField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) { if (e.is(setScope)) { return e.value; } }
    if (!value || !searchPanelOpen(tr.state)) { return null; }
    const from = tr.changes.mapPos(value.from, 1), to = tr.changes.mapPos(value.to, -1);
    return to > from ? { from, to } : null;
  },
  provide: f => EditorView.decorations.from(f, v => v ? Decoration.set([Decoration.mark({ class: 'cm-find-scope' }).range(v.from, v.to)]) : Decoration.none),
});

function button(icon: string, title: string, cls = 'cm-find-btn'): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button'; b.className = cls; b.title = title; b.setAttribute('aria-label', title);
  b.innerHTML = ICONS[icon];
  b.addEventListener('mousedown', e => e.preventDefault()); // keep focus where it is
  return b;
}

type Match = { from: number; to: number; match: RegExpExecArray };
function eachMatch(state: EditorState, query: SearchQuery, scope: { from: number; to: number } | null, fn: (m: Match) => boolean | void) {
  const cursor = query.getCursor(state, scope?.from ?? 0, scope?.to ?? state.doc.length);
  for (let n = 0; n < MAX_COUNT; n++) {
    const r = cursor.next();
    if (r.done) { return; }
    if (fn(r.value as Match) === false) { return; }
  }
}

/** The text a match is replaced with; in regex mode $1, $&, \\n, \\t and \\\\ are expanded. */
function replacement(q: SearchQuery, m: Match): string {
  if (!q.regexp) { return q.replace; }
  return q.replace.replace(/\\([nrt\\])|\$([$&\d]+)/g, (all, esc: string | undefined, ref: string | undefined) => {
    if (esc) { return esc === 'n' ? '\n' : esc === 'r' ? '\r' : esc === 't' ? '\t' : '\\'; }
    if (ref === '$') { return '$'; }
    if (ref === '&') { return m.match[0]; }
    return m.match[Number(ref)] ?? all;
  });
}

class FindPanel implements Panel {
  dom = document.createElement('div');
  top = true;
  private find = document.createElement('input');
  private replace = document.createElement('input');
  private count = document.createElement('div');
  private opts = { caseSensitive: false, wholeWord: false, regexp: false };
  private toggles = new Map<string, HTMLButtonElement>();
  private scopeBtn: HTMLButtonElement;
  private expand: HTMLButtonElement;
  private query: SearchQuery;

  constructor(private view: EditorView) {
    this.query = getSearchQuery(view.state);
    this.dom.className = 'cm-find-widget';
    this.dom.setAttribute('role', 'search');
    this.dom.addEventListener('keydown', e => this.keydown(e));

    this.expand = button('chevron-right', 'Toggle Replace', 'cm-find-btn cm-find-expand');
    this.expand.addEventListener('click', () => this.setReplaceVisible(!this.dom.classList.contains('cm-find-replace-on')));

    const inputWrap = (input: HTMLInputElement, placeholder: string, label: string) => {
      input.placeholder = placeholder; input.setAttribute('aria-label', label);
      input.spellcheck = false; input.autocomplete = 'off';
      const wrap = document.createElement('div');
      wrap.className = 'cm-find-input'; wrap.appendChild(input);
      return wrap;
    };
    const findWrap = inputWrap(this.find, 'Find', 'Find');
    this.find.setAttribute('main-field', 'true'); // @codemirror/search focuses this one on Ctrl+F
    this.find.addEventListener('input', () => { this.commit(); this.selectNearest(); });
    const optionsBox = document.createElement('div');
    optionsBox.className = 'cm-find-options';
    for (const [key, icon, title] of [['caseSensitive', 'case-sensitive', 'Match Case'], ['wholeWord', 'whole-word', 'Match Whole Word'], ['regexp', 'regex', 'Use Regular Expression']] as const) {
      const b = button(icon, `${title} (${isMac ? '⌥⌘' : 'Alt+'}${key === 'caseSensitive' ? 'C' : key === 'wholeWord' ? 'W' : 'R'})`, 'cm-find-toggle');
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => this.toggle(key));
      this.toggles.set(key, b); optionsBox.appendChild(b);
    }
    findWrap.appendChild(optionsBox);

    this.count.className = 'cm-find-count';
    this.count.setAttribute('aria-live', 'polite');
    const prev = button('arrow-up', 'Previous Match (Shift+Enter)');
    prev.addEventListener('click', () => this.step(false));
    const next = button('arrow-down', 'Next Match (Enter)');
    next.addEventListener('click', () => this.step(true));
    this.scopeBtn = button('list-selection', `Find in Selection (${isMac ? '⌥⌘' : 'Alt+'}L)`);
    this.scopeBtn.setAttribute('aria-pressed', 'false');
    this.scopeBtn.addEventListener('click', () => this.toggleScope());
    const close = button('close', 'Close (Escape)');
    close.addEventListener('click', () => this.close());

    const row1 = document.createElement('div');
    row1.className = 'cm-find-row';
    row1.append(findWrap, this.count, prev, next, this.scopeBtn, close);

    const replaceWrap = inputWrap(this.replace, 'Replace', 'Replace');
    this.replace.addEventListener('input', () => this.commit());
    const replaceOne = button('replace', 'Replace (Enter)');
    replaceOne.addEventListener('click', () => this.replaceOne());
    const replaceAll = button('replace-all', `Replace All (${isMac ? '⌘⌥Enter' : 'Ctrl+Alt+Enter'})`);
    replaceAll.addEventListener('click', () => this.replaceAll());
    const row2 = document.createElement('div');
    row2.className = 'cm-find-row cm-find-replace-row';
    row2.append(replaceWrap, replaceOne, replaceAll);

    const rows = document.createElement('div');
    rows.className = 'cm-find-rows';
    rows.append(row1, row2);
    this.dom.append(this.expand, rows);

    this.find.value = this.query.search;
    this.replace.value = this.query.replace;
    this.opts = { caseSensitive: this.query.caseSensitive, wholeWord: this.query.wholeWord, regexp: this.query.regexp };
    this.syncState();
    this.refresh();
  }

  mount() { this.refresh(); this.find.focus(); this.find.select(); }

  private get scope() { return this.view.state.field(scopeField, false) ?? null; }

  private setReplaceVisible(on: boolean) {
    this.dom.classList.toggle('cm-find-replace-on', on);
    this.expand.innerHTML = ICONS[on ? 'chevron-down' : 'chevron-right'];
    this.expand.setAttribute('aria-expanded', String(on));
  }
  /** Opens the replace row and focuses it (Ctrl+H). */
  showReplace() { this.setReplaceVisible(true); this.replace.focus(); this.replace.select(); }

  private syncState() {
    for (const [k, b] of this.toggles) { b.setAttribute('aria-pressed', String(this.opts[k as keyof typeof this.opts])); b.classList.toggle('on', this.opts[k as keyof typeof this.opts]); }
    this.scopeBtn.classList.toggle('on', !!this.scope);
    this.scopeBtn.setAttribute('aria-pressed', String(!!this.scope));
  }

  private commit() {
    const q = new SearchQuery({ search: this.find.value, replace: this.replace.value, ...this.opts });
    if (!q.eq(getSearchQuery(this.view.state))) { this.view.dispatch({ effects: setSearchQuery.of(q) }); }
  }

  private toggle(key: keyof typeof this.opts) {
    this.opts[key] = !this.opts[key];
    this.syncState(); this.commit(); this.selectNearest(); this.find.focus();
  }

  private toggleScope() {
    if (this.scope) { this.view.dispatch({ effects: setScope.of(null) }); }
    else {
      const sel = this.view.state.selection.main;
      if (!sel.empty) { this.view.dispatch({ effects: setScope.of({ from: sel.from, to: sel.to }) }); }
    }
    this.syncState(); this.refresh(); this.find.focus();
  }

  private matches(): Match[] {
    const q = getSearchQuery(this.view.state);
    const out: Match[] = [];
    if (q.valid) { eachMatch(this.view.state, q, this.scope, m => { out.push(m); }); }
    return out;
  }

  private select(m: { from: number; to: number }) {
    this.view.dispatch({ selection: EditorSelection.single(m.from, m.to), effects: EditorView.scrollIntoView(m.from, { y: 'nearest', yMargin: 60 }), userEvent: 'select.search' });
  }

  /** As you type, jump to the first match at or after the cursor (wrapping round). */
  private selectNearest() {
    const all = this.matches();
    if (!all.length) { return; }
    const from = this.view.state.selection.main.from;
    this.select(all.find(m => m.from >= from) ?? all[0]);
  }

  private step(forward: boolean) {
    const all = this.matches();
    if (!all.length) { return; }
    const sel = this.view.state.selection.main;
    this.select(forward
      ? all.find(m => m.from >= sel.to && !(m.from === sel.from && m.to === sel.to)) ?? all[0]
      : [...all].reverse().find(m => m.to <= sel.from) ?? all[all.length - 1]);
  }

  private replaceOne() {
    const q = getSearchQuery(this.view.state);
    if (!q.valid) { return; }
    const sel = this.view.state.selection.main;
    const all = this.matches();
    const current = all.find(m => m.from === sel.from && m.to === sel.to);
    if (!current) { this.step(true); return; }
    const text = replacement(q, current);
    this.view.dispatch({ changes: { from: current.from, to: current.to, insert: text }, userEvent: 'input.replace' });
    this.step(true);
  }

  private replaceAll() {
    const q = getSearchQuery(this.view.state);
    if (!q.valid) { return; }
    const changes = this.matches().map(m => ({ from: m.from, to: m.to, insert: replacement(q, m) }));
    if (changes.length) { this.view.dispatch({ changes, userEvent: 'input.replace.all' }); }
  }

  private close() { closeSearchPanel(this.view); this.view.focus(); }

  private keydown(e: KeyboardEvent) {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); return; }
    if (e.altKey && !e.shiftKey) {
      const k = e.code;
      if (k === 'KeyC') { e.preventDefault(); this.toggle('caseSensitive'); return; }
      if (k === 'KeyW') { e.preventDefault(); this.toggle('wholeWord'); return; }
      if (k === 'KeyR') { e.preventDefault(); this.toggle('regexp'); return; }
      if (k === 'KeyL') { e.preventDefault(); this.toggleScope(); return; }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.target === this.replace) { if (mod && e.altKey) { this.replaceAll(); } else { this.replaceOne(); } }
      else if (mod && e.altKey) { this.replaceAll(); }
      else { this.step(!e.shiftKey); }
      return;
    }
    if (e.key === 'F3') { e.preventDefault(); this.step(!e.shiftKey); }
  }

  /** Called by CodeMirror's search extension when the panel is re-opened (Ctrl+F while open). */
  update(u: ViewUpdate) {
    const q = getSearchQuery(u.state);
    if (!q.eq(this.query)) {
      this.query = q;
      if (document.activeElement !== this.find) { this.find.value = q.search; }
      if (document.activeElement !== this.replace) { this.replace.value = q.replace; }
      this.opts = { caseSensitive: q.caseSensitive, wholeWord: q.wholeWord, regexp: q.regexp };
    }
    this.syncState();
    if (u.docChanged || u.selectionSet || u.transactions.some(tr => tr.effects.length)) { this.refresh(); }
  }

  private refresh() {
    const q = getSearchQuery(this.view.state);
    const all = this.matches();
    const sel = this.view.state.selection.main;
    const index = all.findIndex(m => m.from === sel.from && m.to === sel.to);
    const empty = !q.search;
    const none = !empty && all.length === 0;
    this.count.textContent = empty ? '' : none ? 'No results' : `${index >= 0 ? index + 1 : '?'} of ${all.length >= MAX_COUNT ? MAX_COUNT + '+' : all.length}`;
    this.dom.classList.toggle('cm-find-none', none);
    this.find.parentElement!.classList.toggle('cm-find-error', none);
  }
}

let current: FindPanel | undefined;

/** Ctrl+H: open the find widget with the replace row shown. */
function openReplace(view: EditorView): boolean {
  if (!searchPanelOpen(view.state)) { openSearchPanel(view); }
  current?.showReplace();
  return true;
}

export const findKeymap: KeyBinding[] = [{ key: 'Mod-h', run: openReplace, preventDefault: true }];

export const findWidget = [
  scopeField,
  search({
    top: true,
    createPanel: view => { current = new FindPanel(view); return current; },
  }),
];
