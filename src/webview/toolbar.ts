// Quick-action toolbar shown above the live editor.
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { ICONS } from './icons';

export interface ToolbarHost {
  /** Run a local formatting operation (same messages the VS Code commands send). */
  format(view: EditorView, msg: Record<string, unknown>): void;
  /** Run a VS Code command (for actions that need a picker or prompt). */
  command(id: string): void;
}

interface Button { id: string; icon?: string; text?: string; title: string; run: (view: EditorView) => void; }

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl+';

export function createToolbar(host: ToolbarHost, getView: () => EditorView | undefined): { element: HTMLElement; update(view: EditorView): void } {
  const bar = document.createElement('div');
  bar.id = 'toolbar';
  bar.setAttribute('role', 'toolbar');

  const wrap = (which: string) => (v: EditorView) => host.format(v, { op: 'wrap', which });
  const line = (which: string) => (v: EditorView) => host.format(v, { op: 'line', which });

  // Heading picker
  const heading = document.createElement('select');
  heading.className = 'tb-heading';
  heading.title = 'Text style';
  [['0', 'Normal text'], ['1', 'Heading 1'], ['2', 'Heading 2'], ['3', 'Heading 3'], ['4', 'Heading 4'], ['5', 'Heading 5'], ['6', 'Heading 6']]
    .forEach(([value, label]) => { const o = document.createElement('option'); o.value = value; o.textContent = label; heading.appendChild(o); });
  heading.addEventListener('change', () => {
    const v = getView();
    if (v) { host.format(v, { op: 'heading', level: Number(heading.value) }); }
  });
  bar.appendChild(heading);

  const groups: Button[][] = [
    [
      { id: 'bold', icon: 'bold', title: `Bold (${mod}B)`, run: wrap('bold') },
      { id: 'italic', icon: 'italic', title: `Italic (${mod}I)`, run: wrap('italic') },
      { id: 'strike', text: 'S', title: `Strikethrough (${mod}Shift+X)`, run: wrap('strike') },
      { id: 'highlight', icon: 'symbol-color', title: `Highlight (${mod}Shift+H)`, run: wrap('highlight') },
      { id: 'code', icon: 'code', title: `Inline code (${mod}E)`, run: wrap('code') },
    ],
    [
      { id: 'bullet', icon: 'list-unordered', title: `Bullet list (${mod}Shift+8)`, run: line('bullet') },
      { id: 'numbered', icon: 'list-ordered', title: `Numbered list (${mod}Shift+7)`, run: line('numbered') },
      { id: 'task', icon: 'tasklist', title: `Checkbox (${mod}L)`, run: line('checkbox') },
      { id: 'quote', icon: 'quote', title: 'Quote', run: line('quote') },
    ],
    [
      { id: 'link', icon: 'link', title: `Link to a file (${mod}Alt+L)`, run: () => host.command('diamond.insertLink') },
      { id: 'codeblock', icon: 'file-code', title: `Code block (${mod}Shift+K)`, run: () => host.command('diamond.insertCodeBlock') },
      { id: 'table', icon: 'table', title: 'Insert table', run: () => host.command('diamond.insertTable') },
      { id: 'hr', icon: 'horizontal-rule', title: 'Divider', run: v => host.format(v, { op: 'divider' }) },
    ],
  ];

  const buttons = new Map<string, HTMLButtonElement>();
  const make = (b: Button) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'tb-btn';
    el.title = b.title;
    el.setAttribute('aria-label', b.title);
    if (b.text) { el.textContent = b.text; el.classList.add('tb-text', 'tb-' + b.id); }
    else { el.innerHTML = ICONS[b.icon!]; }
    // Keep the editor focused and its selection intact.
    el.addEventListener('mousedown', e => e.preventDefault());
    el.addEventListener('click', () => { const v = getView(); if (v) { b.run(v); } });
    buttons.set(b.id, el);
    return el;
  };
  for (const group of groups) {
    const sep = document.createElement('span'); sep.className = 'tb-sep'; bar.appendChild(sep);
    group.forEach(b => bar.appendChild(make(b)));
  }

  let lastKey = '';

  /** Reflect the formatting at the cursor in the buttons. */
  function update(view: EditorView) {
    const { state } = view;
    const head = state.selection.main.head;
    const active = new Set<string>();
    let level = 0;
    for (let node: any = syntaxTree(state).resolveInner(head, -1); node; node = node.parent) {
      switch (node.name) {
        case 'StrongEmphasis': active.add('bold'); break;
        case 'Emphasis': active.add('italic'); break;
        case 'Strikethrough': active.add('strike'); break;
        case 'Highlight': active.add('highlight'); break;
        case 'InlineCode': active.add('code'); break;
        case 'Blockquote': active.add('quote'); break;
        case 'FencedCode': active.add('codeblock'); break;
        case 'Table': active.add('table'); break;
        case 'WikiLink': case 'Link': active.add('link'); break;
        case 'ListItem':
          if (node.getChild('Task')) { active.add('task'); }
          else if (node.parent?.name === 'BulletList') { active.add('bullet'); }
          else if (node.parent?.name === 'OrderedList') { active.add('numbered'); }
          break;
        default: {
          const m = /^ATXHeading(\d)$/.exec(node.name);
          if (m && !level) { level = Number(m[1]); }
        }
      }
    }
    // Task markers belong to the list item's paragraph: check the line itself too.
    if (/^\s*([-*+]|\d+[.)])\s+\[[ xX]\]/.test(state.doc.lineAt(head).text)) { active.add('task'); active.delete('bullet'); active.delete('numbered'); }
    // Only touch the DOM when something changed (this runs on every cursor move).
    const key = [...active].join() + level;
    if (key === lastKey) { return; }
    lastKey = key;
    buttons.forEach((el, id) => el.classList.toggle('active', active.has(id)));
    heading.value = String(level);
  }

  return { element: bar, update };
}
