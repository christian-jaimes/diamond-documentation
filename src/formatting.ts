import * as vscode from 'vscode';
import * as path from 'path';
import * as fmt from './shared/format';
import * as md from './shared/mdTools';
import type { LinkIndex } from './linkIndex';

/** A format request sent to the live editor webview (see src/webview/liveEditor.ts). */
export type FormatMessage =
  | { op: 'wrap'; which: fmt.WrapOp }
  | { op: 'line'; which: fmt.LineOp }
  | { op: 'codeBlock'; lang: string }
  | { op: 'insert'; text: string; selFrom: number; selTo: number }
  | { op: 'link'; target: string }
  | { op: 'formatTable' }
  | { op: 'toc' }
  | { op: 'renumber' };

/** Implemented by the live editor provider: forwards a request to the focused live editor, if any. */
export interface LiveTarget {
  format(msg: FormatMessage): boolean;
  /** The document of the focused live editor, if any. */
  active?(): { document: vscode.TextDocument } | undefined;
}

/** Run an editor-agnostic edit against the active text editor. */
async function applyToTextEditor(fn: (text: string, sels: fmt.Sel[]) => fmt.EditResult | undefined) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return; }
  const doc = editor.document;
  const sels = editor.selections.map(s => ({ anchor: doc.offsetAt(s.anchor), head: doc.offsetAt(s.active) }));
  const result = fn(doc.getText(), sels);
  if (!result) { return; }
  await editor.edit(e => {
    for (const c of result.changes) { e.replace(new vscode.Range(doc.positionAt(c.from), doc.positionAt(c.to)), c.insert); }
  });
  if (result.selections.length) { editor.selections = result.selections.map(s => new vscode.Selection(doc.positionAt(s.anchor), doc.positionAt(s.head))); }
  editor.revealRange(editor.selection);
}

/** Enter key in the source editor: continue lists / checkboxes / quotes, or end the list on an empty item. */
async function onEnter() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return; }
  const pos = editor.selection.active;
  const line = editor.document.lineAt(pos.line);
  const cb = fmt.CHECKBOX.exec(line.text);
  const num = fmt.NUMBERED.exec(line.text);
  const bul = fmt.BULLET.exec(line.text);
  const quote = /^(\s*>\s?)/.exec(line.text);
  const m = cb || num || bul || quote;

  if (!m || !editor.selection.isEmpty || pos.character < m[0].length) {
    return vscode.commands.executeCommand('type', { source: 'keyboard', text: '\n' });
  }
  if (line.text.trim() === m[0].trim()) {
    await editor.edit(e => e.replace(line.range, ''));
    return;
  }
  let prefix: string;
  if (cb) { prefix = `${cb[1]}${cb[2].replace(/^(\d+)/, d => String(+d + 1))} [ ] `; }
  else if (num) { prefix = `${num[1]}${+num[2] + 1}${line.text.charAt(num[1].length + num[2].length)} `; }
  else if (bul) { prefix = bul[0]; }
  else { prefix = quote![1]; }
  await editor.edit(e => e.insert(pos, '\n' + prefix));
  editor.revealRange(editor.selection);
}

/** Tab / Shift+Tab in the source editor: move between table cells, otherwise behave as usual. */
async function tableTab(forward: boolean) {
  const editor = vscode.window.activeTextEditor;
  const fallback = () => vscode.commands.executeCommand(forward ? 'tab' : 'outdent');
  if (!editor || editor.selections.length !== 1 || editor.selection.start.line !== editor.selection.end.line) { return fallback(); }
  const doc = editor.document;
  const result = md.tableNavigate(doc.getText(), doc.offsetAt(editor.selection.active), forward);
  if (!result) { return fallback(); }
  await applyToTextEditor(() => result);
}

const HTML_STYLE = `body{font:16px/1.6 -apple-system,'Segoe UI',Roboto,sans-serif;max-width:860px;margin:2rem auto;padding:0 1.25rem;color:#1f2328}
h1,h2{border-bottom:1px solid #d0d7de;padding-bottom:.3em}code{background:#eff1f3;padding:.15em .35em;border-radius:4px;font-size:90%}
pre{background:#f6f8fa;padding:1rem;overflow:auto;border-radius:6px}pre code{background:none;padding:0}
table{border-collapse:collapse}th,td{border:1px solid #d0d7de;padding:.4em .8em}blockquote{margin:0;padding:0 1em;color:#59636e;border-left:.25em solid #d0d7de}
img{max-width:100%}mark{background:#fff3a3}a{color:#0969da}@media print{body{margin:0;max-width:none}pre{white-space:pre-wrap}}`;

/** Render the note with VS Code's Markdown renderer and save it as a standalone .html file next to it. */
async function exportHtml(live: LiveTarget) {
  const doc = live.active?.()?.document ?? (vscode.window.activeTextEditor?.document.languageId === 'markdown' ? vscode.window.activeTextEditor.document : undefined);
  if (!doc) { vscode.window.showInformationMessage('Open a Markdown file first.'); return; }
  if (doc.uri.scheme !== 'file') { vscode.window.showInformationMessage('Export to HTML works on files saved on disk.'); return; }
  let body: string;
  try { body = await vscode.commands.executeCommand<string>('markdown.api.render', doc.getText()); }
  catch { vscode.window.showErrorMessage('Could not render the note: the Markdown extension of VS Code is disabled.'); return; }
  const title = path.basename(doc.fileName, path.extname(doc.fileName));
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${HTML_STYLE}</style></head><body>
${body}
</body></html>
`;
  const out = vscode.Uri.file(path.join(path.dirname(doc.fileName), title + '.html'));
  await vscode.workspace.fs.writeFile(out, Buffer.from(html, 'utf8'));
  const pick = await vscode.window.showInformationMessage(`Exported ${path.basename(out.fsPath)}. Open it in your browser to print or save as PDF.`, 'Open in Browser');
  if (pick) { await vscode.env.openExternal(out); }
}

const CODE_LANGUAGES = ['', 'ts', 'js', 'tsx', 'python', 'bash', 'powershell', 'json', 'yaml', 'sql', 'csharp', 'java', 'go', 'rust', 'html', 'css', 'xml', 'mermaid'];

export function registerFormatting(ctx: vscode.ExtensionContext, live: LiveTarget, index: LinkIndex) {
  const reg = (id: string, fn: () => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  /** Send to the live editor when it is focused, otherwise edit the text editor. */
  const run = (msg: FormatMessage, fallback: (text: string, sels: fmt.Sel[]) => fmt.EditResult | undefined) =>
    live.format(msg) ? undefined : applyToTextEditor(fallback);

  const wrap = (which: fmt.WrapOp) => () => run({ op: 'wrap', which }, (t, s) => fmt.toggleWrap(t, s, fmt.WRAP_OPS[which]));
  const line = (which: fmt.LineOp) => () => run({ op: 'line', which }, (t, s) => fmt.transformLines(t, s, fmt.LINE_OPS[which]));

  reg('diamond.toggleBold', wrap('bold'));
  reg('diamond.toggleItalic', wrap('italic'));
  reg('diamond.toggleStrikethrough', wrap('strike'));
  reg('diamond.toggleHighlight', wrap('highlight'));
  reg('diamond.toggleInlineCode', wrap('code'));
  reg('diamond.toggleCheckbox', line('checkbox'));
  reg('diamond.toggleBullet', line('bullet'));
  reg('diamond.toggleNumbered', line('numbered'));
  reg('diamond.cycleHeading', line('heading'));
  reg('diamond.toggleQuote', line('quote'));
  reg('diamond.formatTable', () => run({ op: 'formatTable' }, (t, s) => fmt.formatTable(t, s[0]?.head ?? 0)));
  reg('diamond.onEnter', onEnter);
  reg('diamond.updateToc', () => run({ op: 'toc' }, (t, s) => md.updateToc(t, s[0]?.head ?? 0)));
  reg('diamond.renumberLists', () => run({ op: 'renumber' }, t => md.renumberLists(t)));
  reg('diamond.tableNextCell', () => tableTab(true));
  reg('diamond.tablePreviousCell', () => tableTab(false));
  reg('diamond.exportHtml', () => exportHtml(live));

  // Keep a table of contents (between <!-- toc --> markers) current when the note is saved.
  ctx.subscriptions.push(vscode.workspace.onWillSaveTextDocument(e => {
    if (e.document.languageId !== 'markdown' || !vscode.workspace.getConfiguration('diamond.toc').get('updateOnSave', true)) { return; }
    const text = e.document.getText();
    if (!text.includes(md.TOC_START) || !text.includes(md.TOC_END)) { return; }
    const r = md.updateToc(text, 0);
    if (!r) { return; }
    e.waitUntil(Promise.resolve(r.changes.map(c => vscode.TextEdit.replace(new vscode.Range(e.document.positionAt(c.from), e.document.positionAt(c.to)), c.insert))));
  }));

  reg('diamond.insertCodeBlock', async () => {
    const pick = await vscode.window.showQuickPick(CODE_LANGUAGES.map(l => ({ label: l || '(none)', value: l })), { placeHolder: 'Code block language' });
    if (pick) { await run({ op: 'codeBlock', lang: pick.value }, (t, s) => fmt.codeBlock(t, s, pick.value)); }
  });

  reg('diamond.insertTable', async () => {
    const size = await vscode.window.showInputBox({ prompt: 'Table size as columns x rows', value: '3x3', validateInput: v => /^\s*\d+\s*[xX*]\s*\d+\s*$/.test(v) ? undefined : 'Use the form 3x3' });
    if (!size) { return; }
    const [cols, rows] = size.split(/[xX*]/).map(s => Math.max(1, parseInt(s.trim(), 10)));
    const { text, selFrom, selTo } = fmt.tableText(cols, rows);
    await run({ op: 'insert', text, selFrom, selTo }, (_t, s) => fmt.insertText(s, text, selFrom, selTo));
  });

  reg('diamond.insertLink', async () => {
    const items = index.allFiles().map(uri => ({ label: index.linkTextFor(uri), description: index.relativePath(uri) }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Link to file…', matchOnDescription: true });
    if (!pick) { return; }
    await run({ op: 'link', target: pick.label }, (t, s) => {
      const sel = s[0];
      const selected = t.slice(Math.min(sel.anchor, sel.head), Math.max(sel.anchor, sel.head));
      const link = `[[${pick.label}${selected ? '|' + selected : ''}]]`;
      return fmt.insertText(s, link);
    });
  });
}
