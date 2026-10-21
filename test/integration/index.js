// Runs inside a real VS Code extension host against sample-docs/.
// Writes its outcome to result.txt next to this file.
const vscode = require('vscode');
const assert = require('assert');
const fs = require('fs'), path = require('path');
const out = path.join(__dirname, 'result.txt');
const log = [];
const wait = ms => new Promise(r => setTimeout(r, ms));

exports.run = async function () {
  try { await main(); fs.writeFileSync(out, 'INTEGRATION OK\n' + log.join('\n')); }
  catch (e) { fs.writeFileSync(out, 'FAIL ' + (e && e.stack || e) + '\n' + log.join('\n')); throw e; }
};

async function waitFor(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) { return; } await wait(150); }
  throw new Error('Timed out waiting for ' + what);
}

async function main() {
  const ext = vscode.extensions.all.find(e => e.id.endsWith('diamond-documentation'));
  await ext.activate();
  const root = vscode.workspace.workspaceFolders[0].uri;
  const at = p => vscode.Uri.joinPath(root, ...p.split('/'));
  const read = async p => Buffer.from(await vscode.workspace.fs.readFile(at(p))).toString('utf8');

  const cfg = vscode.workspace.getConfiguration('diamond.liveEditor');
  await cfg.update('openByDefault', false, vscode.ConfigurationTarget.Global); // source-editor checks first
  const readme = at('README.md');
  const doc = await vscode.workspace.openTextDocument(readme);
  await vscode.window.showTextDocument(doc);
  await wait(1500); // let the index build

  // Links, click-through and go-to-heading
  const links = await vscode.commands.executeCommand('vscode.executeLinkProvider', readme);
  const wiki = links.filter(l => l.target && l.target.scheme === 'command');
  assert.ok(wiki.length >= 4, 'expected wikilinks, got ' + wiki.length);
  const args = JSON.parse(decodeURIComponent(wiki[0].target.query))[0];
  await vscode.commands.executeCommand('diamond.openLink', args);
  assert.ok(vscode.window.activeTextEditor.document.uri.path.endsWith('Getting Started.md'));
  const gs = vscode.window.activeTextEditor.document;
  const line = gs.getText().split('\n').findIndex(l => l.includes('Architecture Overview#Components'));
  const defs = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', gs.uri, new vscode.Position(line, gs.lineAt(line).text.indexOf('[[') + 3));
  assert.ok(defs[0].uri.path.endsWith('Architecture Overview.md') && defs[0].range.start.line === 2);
  log.push('links ok');

  // Formatting in the source editor
  const scratch = await vscode.workspace.openTextDocument({ language: 'markdown', content: 'hello world\n- [ ] task' });
  const ed = await vscode.window.showTextDocument(scratch);
  ed.selection = new vscode.Selection(0, 0, 0, 5);
  await vscode.commands.executeCommand('diamond.toggleBold');
  assert.strictEqual(scratch.lineAt(0).text, '**hello** world');
  await vscode.commands.executeCommand('diamond.toggleBold');
  assert.strictEqual(scratch.lineAt(0).text, 'hello world');
  ed.selection = new vscode.Selection(1, 3, 1, 3);
  await vscode.commands.executeCommand('diamond.toggleCheckbox');
  assert.strictEqual(scratch.lineAt(1).text, '- [x] task');
  ed.selection = new vscode.Selection(1, 10, 1, 10);
  await vscode.commands.executeCommand('diamond.onEnter');
  assert.strictEqual(scratch.lineAt(2).text, '- [ ] ');
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  log.push('source formatting ok');

  // Live editor: VS Code command → webview → edit back into the TextDocument
  const liveUri = at('live-test.md');
  await vscode.workspace.fs.writeFile(liveUri, Buffer.from('hello'));
  await vscode.commands.executeCommand('vscode.openWith', liveUri, 'diamond.liveEditor');
  const liveDoc = await vscode.workspace.openTextDocument(liveUri);
  await wait(2500); // webview boot
  await vscode.commands.executeCommand('diamond.toggleCheckbox');
  await waitFor(() => liveDoc.getText() === '- [ ] hello', 'live editor checkbox (got ' + JSON.stringify(liveDoc.getText()) + ')');
  // …and an edit made elsewhere shows up in the live editor and round-trips.
  const we = new vscode.WorkspaceEdit();
  we.insert(liveUri, new vscode.Position(0, liveDoc.getText().length), ' world');
  await vscode.workspace.applyEdit(we);
  await wait(300);
  await vscode.commands.executeCommand('diamond.toggleCheckbox');
  await waitFor(() => liveDoc.getText() === '- [x] hello world', 'second live edit (got ' + JSON.stringify(liveDoc.getText()) + ')');
  await liveDoc.save();
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await vscode.workspace.fs.delete(liveUri);
  log.push('live editor ok');

  // Renaming a file silently updates [[wikilinks]] and [markdown](links), and saves them
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const rename = async (from, to) => {
    const e = new vscode.WorkspaceEdit();
    e.renameFile(at(from), at(to));
    assert.ok(await vscode.workspace.applyEdit(e), 'rename failed');
  };
  await rename('docs/architecture/API Design.md', 'docs/architecture/API Spec.md');
  await waitFor(async () => (await read('docs/architecture/Storage.md')).includes('(API%20Spec.md)'), 'markdown link update');
  await waitFor(async () => (await read('docs/architecture/Architecture Overview.md')).includes('[[API Spec]]'), 'wikilink update');
  assert.ok(!vscode.workspace.textDocuments.some(d => d.isDirty), 'files should be saved');
  await rename('docs/architecture/API Spec.md', 'docs/architecture/API Design.md');
  await waitFor(async () => (await read('docs/architecture/Architecture Overview.md')).includes('[[API Design]]'), 'rename back');
  await waitFor(async () => (await read('docs/architecture/Storage.md')).includes('(API%20Design.md)'), 'markdown link back');
  log.push('rename ok');

  // Moving a whole folder re-bases relative links inside it
  await rename('docs/architecture', 'docs/design');
  await waitFor(async () => (await read('docs/design/Architecture Overview.md')).includes('[[API Design]]'), 'folder move');
  await rename('docs/design', 'docs/architecture');
  await wait(800);
  log.push('folder move ok');

  // Markdown opens in the live editor by default; "source" switches in place and sticks
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await cfg.update('openByDefault', true, vscode.ConfigurationTarget.Global);
  const activeInput = () => vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  const tabCount = () => vscode.window.tabGroups.all.reduce((n, g) => n + g.tabs.length, 0);
  await vscode.commands.executeCommand('vscode.open', at('docs/Getting Started.md'));
  await waitFor(() => activeInput() instanceof vscode.TabInputCustom && tabCount() === 1, 'redirect to live editor');
  await wait(1500);
  await vscode.commands.executeCommand('diamond.openSourceEditor');
  await waitFor(() => activeInput() instanceof vscode.TabInputText && tabCount() === 1, 'switch to source in place');
  await wait(500);
  assert.ok(activeInput() instanceof vscode.TabInputText, 'source view should not bounce back');
  await vscode.commands.executeCommand('diamond.openLiveEditor');
  await waitFor(() => activeInput() instanceof vscode.TabInputCustom && tabCount() === 1, 'switch back to live');
  // Git-style diffs stay text diffs
  await vscode.commands.executeCommand('vscode.diff', at('docs/Getting Started.md'), at('README.md'), 'diff');
  await wait(800);
  assert.ok(activeInput() instanceof vscode.TabInputTextDiff, 'diff should stay a text diff');
  // Following a link from the live editor opens the target in the live editor
  await vscode.commands.executeCommand('diamond.openLink', { from: at('README.md').toString(), target: 'Storage', kind: 'wiki' });
  await waitFor(() => activeInput() instanceof vscode.TabInputCustom && activeInput().uri.path.endsWith('Storage.md'), 'link opens live');
  log.push('open by default ok');

  // Windows line endings (CRLF): live editor edits land on the right line
  const crlf = at('crlf-test.md');
  await vscode.workspace.fs.writeFile(crlf, Buffer.from('# A\r\n\r\n# B\r\ntext'));
  await wait(500);
  await vscode.commands.executeCommand('diamond.openLink', { from: crlf.toString(), target: '', heading: 'B', kind: 'wiki' });
  const crlfDoc = await vscode.workspace.openTextDocument(crlf);
  await wait(2500); // webview boot; cursor is revealed on line 3 ("# B")
  await vscode.commands.executeCommand('diamond.toggleCheckbox');
  await waitFor(() => crlfDoc.getText() === '# A\r\n\r\n- [ ] # B\r\ntext', 'CRLF edit (got ' + JSON.stringify(crlfDoc.getText()) + ')');
  await vscode.commands.executeCommand('diamond.toggleQuote');
  await waitFor(() => crlfDoc.getText() === '# A\r\n\r\n> - [ ] # B\r\ntext', 'second CRLF edit (got ' + JSON.stringify(crlfDoc.getText()) + ')');
  await crlfDoc.save();
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await vscode.workspace.fs.delete(crlf);
  log.push('crlf ok');

  // Images render (and actually load) in the live editor: Markdown, HTML, embeds, badges, tables
  const imgNote = at('images-test.md');
  await vscode.workspace.fs.writeFile(imgNote, Buffer.from([
    '# Images', '',
    '![markdown](assets/logo.svg)', '',
    '<p align="center"><img src="assets/logo.svg" width="64" alt="html"></p>', '',
    'Embed: ![[logo.svg|40]]', '',
    'Badge: [![badge](assets/logo.svg)](https://example.com)', '',
    '| Icon |', '| --- |', '| ![cell](assets/logo.svg) |', '',
  ].join('\n')));
  await wait(800);
  await vscode.commands.executeCommand('vscode.openWith', imgNote, 'diamond.liveEditor');
  let images;
  await waitFor(async () => {
    images = await vscode.commands.executeCommand('diamond._probeLiveEditor');
    return Array.isArray(images) && images.length >= 5 && images.every(i => i.loaded);
  }, 'images to load (got ' + JSON.stringify(images) + ')', 10000);
  assert.deepStrictEqual(images.map(i => i.alt).sort(), ['badge', 'cell', 'html', 'logo.svg', 'markdown']);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await vscode.workspace.fs.delete(imgNote);
  log.push('images ok');

  // Clipboard in the live editor (Ctrl+C/X/V run the same path as these commands)
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const clipNote = at('clipboard-test.md');
  await vscode.workspace.fs.writeFile(clipNote, Buffer.from('hello world'));
  await vscode.commands.executeCommand('vscode.openWith', clipNote, 'diamond.liveEditor');
  const clipDoc = await vscode.workspace.openTextDocument(clipNote);
  await wait(2500);
  const select = range => vscode.commands.executeCommand('diamond._probeLiveEditor', range);
  await select([0, 5]);
  await vscode.commands.executeCommand('diamond.liveCopy');
  await waitFor(async () => (await vscode.env.clipboard.readText()) === 'hello', 'copy');
  await select([5, 11]);
  await vscode.commands.executeCommand('diamond.liveCut');
  await waitFor(async () => (await vscode.env.clipboard.readText()) === ' world' && clipDoc.getText() === 'hello', 'cut');
  await vscode.env.clipboard.writeText('XYZ ');
  await select([0, 0]);
  await vscode.commands.executeCommand('diamond.livePaste');
  await waitFor(() => clipDoc.getText() === 'XYZ hello', 'paste (got ' + JSON.stringify(clipDoc.getText()) + ')');
  log.push('clipboard ok');

  // Switching views with unsaved changes saves first (no "Save changes?" prompt, which would hang this test)
  assert.ok(clipDoc.isDirty, 'expected unsaved changes before switching');
  await vscode.commands.executeCommand('diamond.openSourceEditor');
  await waitFor(() => activeInput() instanceof vscode.TabInputText && tabCount() === 1, 'switch to source');
  assert.ok(!clipDoc.isDirty, 'switching to the source should save');
  const srcEdit = new vscode.WorkspaceEdit();
  srcEdit.insert(clipNote, new vscode.Position(0, 0), '# ');
  await vscode.workspace.applyEdit(srcEdit);
  assert.ok(clipDoc.isDirty);
  await vscode.commands.executeCommand('diamond.openLiveEditor');
  await waitFor(() => activeInput() instanceof vscode.TabInputCustom && tabCount() === 1, 'switch to live editor');
  assert.ok(!clipDoc.isDirty, 'switching to the live editor should save');
  assert.strictEqual(Buffer.from(await vscode.workspace.fs.readFile(clipNote)).toString(), '# XYZ hello');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.workspace.fs.delete(clipNote);
  log.push('switch saves ok');

  // The side bar graph view resolves
  await vscode.commands.executeCommand('diamond.graphView.focus');
  await wait(800);
  log.push('sidebar graph ok');

  // Toolbar-only commands are reachable, and the status bar settings exist
  assert.ok((await vscode.commands.getCommands(true)).includes('diamond.toggleLiveEditorDefault'));
  assert.strictEqual(vscode.workspace.getConfiguration('diamond.statusBar').get('enabled'), true);

  // Graph panel and side bar
  await vscode.commands.executeCommand('diamond.openGraph');
  await vscode.commands.executeCommand('workbench.view.extension.diamond');
  await wait(1000);
  log.push('graph ok');
}
