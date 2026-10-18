import * as vscode from 'vscode';
import { LinkIndex } from './linkIndex';
import { LiveEditorProvider } from './liveEditor';
import { textStats } from './shared/stats';

/**
 * Status bar (right side, next to Ln/Col) for the active Markdown file:
 * words · characters · backlinks · outgoing links, plus Ln/Col for the live editor.
 */
export function registerStatusBar(ctx: vscode.ExtensionContext, index: LinkIndex, live: LiveEditorProvider) {
  const R = vscode.StatusBarAlignment.Right;
  // VS Code's own Ln/Col sits at priority 100; keep ours just to its left.
  const position = vscode.window.createStatusBarItem('diamond.position', R, 100.5);
  const words = vscode.window.createStatusBarItem('diamond.words', R, 99.9);
  const chars = vscode.window.createStatusBarItem('diamond.chars', R, 99.8);
  const back = vscode.window.createStatusBarItem('diamond.backlinks', R, 99.7);
  const out = vscode.window.createStatusBarItem('diamond.outgoing', R, 99.6);
  position.name = 'Diamond: Cursor Position'; words.name = 'Diamond: Word Count'; chars.name = 'Diamond: Character Count';
  back.name = 'Diamond: Backlinks'; out.name = 'Diamond: Outgoing Links';
  back.command = 'diamond.backlinks.focus';
  out.command = 'diamond.outgoing.focus';
  const items = [position, words, chars, back, out];

  let cache: { key: string; version: number; words: number; chars: number } | undefined;
  const statsFor = (doc: vscode.TextDocument) => {
    const key = doc.uri.toString();
    if (cache?.key !== key || cache.version !== doc.version) { cache = { key, version: doc.version, ...textStats(doc.getText()) }; }
    return cache;
  };
  const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;

  const update = () => {
    const cfg = vscode.workspace.getConfiguration('diamond.statusBar');
    if (!cfg.get<boolean>('enabled', true)) { items.forEach(i => i.hide()); return; }

    const liveActive = live.active();
    const editor = vscode.window.activeTextEditor;
    const doc = liveActive?.document ?? (editor?.document.languageId === 'markdown' ? editor.document : undefined);
    if (!doc) { items.forEach(i => i.hide()); return; }

    const total = statsFor(doc);
    let selWords = 0, selChars = 0;
    if (liveActive) {
      selWords = liveActive.selection?.selWords ?? 0;
      selChars = liveActive.selection?.selChars ?? 0;
      const sel = liveActive.selection;
      position.text = sel ? `Ln ${sel.line}, Col ${sel.col}` : '';
      position.tooltip = 'Cursor position in the live editor';
      sel ? position.show() : position.hide();
    } else {
      position.hide();
      const selected = editor!.selections.filter(s => !s.isEmpty).map(s => doc.getText(s)).join('\n');
      if (selected) { const s = textStats(selected); selWords = s.words; selChars = s.chars; }
    }

    words.text = selWords ? `${selWords.toLocaleString()} of ${plural(total.words, 'word')}` : plural(total.words, 'word');
    words.tooltip = 'Words (Markdown syntax is not counted)';
    chars.text = selChars ? `${selChars.toLocaleString()} of ${plural(total.chars, 'character')}` : plural(total.chars, 'character');
    chars.tooltip = 'Characters, including spaces, excluding line breaks and Markdown syntax';

    const backlinks = new Set(index.backlinks(doc.uri).filter(b => b.source.toString() !== doc.uri.toString()).map(b => b.source.toString())).size;
    const outgoing = new Set((index.note(doc.uri)?.links ?? []).filter(l => l.target).map(l => index.resolve(l, doc.uri)?.toString() ?? 'missing:' + l.target.toLowerCase())).size;
    back.text = `$(references) ${plural(backlinks, 'backlink')}`;
    back.tooltip = 'Files linking to this note. Click to show them.';
    out.text = `$(link) ${plural(outgoing, 'link')}`;
    out.tooltip = 'Files this note links to. Click to show them.';
    [words, chars, back, out].forEach(i => i.show());
  };

  let timer: NodeJS.Timeout | undefined;
  const soon = () => { clearTimeout(timer); timer = setTimeout(update, 150); };

  ctx.subscriptions.push(...items,
    vscode.window.onDidChangeTextEditorSelection(soon),
    vscode.workspace.onDidChangeTextDocument(e => { if (e.document.languageId === 'markdown') { soon(); } }),
    vscode.window.tabGroups.onDidChangeTabs(soon),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('diamond.statusBar')) { update(); } }),
    live.onDidChangeActive(soon),
    index.onDidChange(soon),
  );
  index.ready.then(update);
}
