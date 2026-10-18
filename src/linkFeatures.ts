import * as vscode from 'vscode';
import * as path from 'path';
import { LinkIndex, isMarkdown } from './linkIndex';
import { IMAGE, parseNote, ParsedLink, slugify } from './parser';

const MD: vscode.DocumentSelector = [{ language: 'markdown' }];

interface OpenLinkArgs { from: string; target: string; heading?: string; kind: ParsedLink['kind']; }

export interface OpenOptions {
  beside?: boolean;
  /** Set when the link was followed from the live editor: notes then open in the live editor too. */
  live?: { revealWhenOpen(uri: vscode.Uri, line: number): void };
}

/** The wikilink under the cursor (only the current line is parsed). */
function linkAt(doc: vscode.TextDocument, pos: vscode.Position): ParsedLink | undefined {
  return parseNote(doc.lineAt(pos.line).text).links
    .find(l => l.kind === 'wiki' && pos.character >= l.start && pos.character <= l.end);
}

/** Line of `#heading` or `#^block-id` inside a note, if found. */
function anchorLine(index: LinkIndex, uri: vscode.Uri, text: string, heading: string): number | undefined {
  const wanted = slugify(heading.replace(/^\^/, ''));
  const line = (index.note(uri) ?? parseNote(text)).headings.find(h => slugify(h.text) === wanted)?.line;
  if (line !== undefined || !heading.startsWith('^')) { return line; }
  const i = text.split(/\r?\n/).findIndex(l => l.trimEnd().endsWith(heading));
  return i >= 0 ? i : undefined;
}

/** The live editor, used when it is the default editor for Markdown. */
let defaultLive: OpenOptions['live'];
export function setLiveTarget(live: OpenOptions['live']) { defaultLive = live; }

/** Opens a link target; offers to create the note if it does not exist yet. */
export async function openLink(index: LinkIndex, args: OpenLinkArgs, opts: OpenOptions = {}) {
  const from = vscode.Uri.parse(args.from);
  const uri = index.resolve(args, from) ?? await createNote(args.target, from);
  if (!uri) { return; }
  const viewColumn = opts.beside ? vscode.ViewColumn.Beside : undefined;
  if (!isMarkdown(uri)) {
    // Code, images, PDFs, binaries…: VS Code picks the right editor.
    await vscode.commands.executeCommand('vscode.open', uri, viewColumn);
    return;
  }
  const text = args.heading ? Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8') : '';
  const line = args.heading ? anchorLine(index, uri, text, args.heading) : undefined;

  const live = opts.live ?? (vscode.workspace.getConfiguration('diamond.liveEditor').get('openByDefault', true) ? defaultLive : undefined);
  if (live) {
    if (line !== undefined) { live.revealWhenOpen(uri, line); }
    await vscode.commands.executeCommand('vscode.openWith', uri, 'diamond.liveEditor', viewColumn);
    return;
  }
  const at = new vscode.Position(line ?? 0, 0);
  await vscode.window.showTextDocument(uri, { viewColumn, preview: false, selection: new vscode.Range(at, at) });
}

async function createNote(target: string, from: vscode.Uri): Promise<vscode.Uri | undefined> {
  const folderSetting = vscode.workspace.getConfiguration('diamond').get<string>('newNoteFolder', '');
  const root = vscode.workspace.getWorkspaceFolder(from)?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
  const base = folderSetting && root ? vscode.Uri.joinPath(root, folderSetting) : vscode.Uri.joinPath(from, '..');
  const uri = vscode.Uri.joinPath(base, path.posix.extname(target) ? target : `${target}.md`);
  const choice = await vscode.window.showInformationMessage(`"${target}" does not exist yet. Create ${vscode.workspace.asRelativePath(uri)}?`, 'Create', 'Cancel');
  if (choice !== 'Create') { return undefined; }
  const title = path.posix.basename(target, path.posix.extname(target));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(isMarkdown(uri) ? `# ${title}\n\n` : ''));
  return uri;
}

class WikiLinkProvider implements vscode.DocumentLinkProvider {
  constructor(private index: LinkIndex) {}
  provideDocumentLinks(doc: vscode.TextDocument): vscode.DocumentLink[] {
    return parseNote(doc.getText()).links.filter(l => l.kind === 'wiki').map(l => {
      const range = new vscode.Range(l.line, l.start + (l.embed ? 3 : 2), l.line, l.end - 2);
      const args: OpenLinkArgs = { from: doc.uri.toString(), target: l.target, heading: l.heading, kind: 'wiki' };
      const link = new vscode.DocumentLink(range, vscode.Uri.parse(`command:diamond.openLink?${encodeURIComponent(JSON.stringify([args]))}`));
      const resolved = this.index.resolve(l, doc.uri);
      link.tooltip = resolved ? `Open ${this.index.relativePath(resolved)}${l.heading ? ' › ' + l.heading : ''}` : `Create "${l.target}"`;
      return link;
    });
  }
}

class WikiCompletionProvider implements vscode.CompletionItemProvider {
  /** Link text and path for every file; rebuilt only when files are added, removed or renamed. */
  private entries: { text: string; rel: string; md: boolean }[] | undefined;

  constructor(private index: LinkIndex) {
    index.onDidChangeFiles(() => { this.entries = undefined; });
  }

  provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): vscode.CompletionItem[] | undefined {
    const lineText = doc.lineAt(pos.line).text;
    const m = /\[\[([^\[\]|]*)$/.exec(lineText.slice(0, pos.character));
    if (!m) { return undefined; }
    const typed = m[1];
    const closing = lineText.startsWith(']]', pos.character) ? '' : ']]';

    // [[note#  → headings of that note
    const hash = typed.indexOf('#');
    if (hash >= 0) {
      const uri = this.index.resolve({ target: typed.slice(0, hash), kind: 'wiki' }, doc.uri);
      const range = new vscode.Range(pos.line, pos.character - (typed.length - hash - 1), pos.line, pos.character);
      return (uri && this.index.note(uri)?.headings || []).map(h => {
        const item = new vscode.CompletionItem(h.text, vscode.CompletionItemKind.Reference);
        item.range = range; item.insertText = h.text + closing; item.detail = 'H' + h.level;
        return item;
      });
    }

    this.entries ??= this.index.allFiles().map(uri => ({ text: this.index.linkTextFor(uri), rel: this.index.relativePath(uri), md: isMarkdown(uri) }));
    const range = new vscode.Range(pos.line, pos.character - typed.length, pos.line, pos.character);
    return this.entries.map(({ text, rel, md }) => {
      const item = new vscode.CompletionItem({ label: text, description: rel }, md ? vscode.CompletionItemKind.File : vscode.CompletionItemKind.Reference);
      item.range = range;
      item.insertText = text + closing;
      item.filterText = `${text} ${rel}`;
      item.sortText = (md ? '0' : '1') + text.toLowerCase();
      return item;
    });
  }
}

class WikiHoverProvider implements vscode.HoverProvider {
  constructor(private index: LinkIndex) {}
  async provideHover(doc: vscode.TextDocument, pos: vscode.Position) {
    const link = linkAt(doc, pos);
    if (!link) { return undefined; }
    const range = new vscode.Range(pos.line, link.start, pos.line, link.end);
    const uri = this.index.resolve(link, doc.uri);
    if (!uri) { return new vscode.Hover(`*"${link.target}" does not exist yet — click to create it.*`, range); }
    const md = new vscode.MarkdownString(`**${this.index.relativePath(uri)}**\n\n---\n\n`);
    if (IMAGE.test(uri.path)) {
      md.appendMarkdown(`![preview](${uri.toString()}|height=200)`);
    } else {
      try {
        const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        const lines = text.split(/\r?\n/, 25).join('\n');
        if (isMarkdown(uri)) { md.appendMarkdown(lines); } else { md.appendCodeblock(lines, path.extname(uri.path).slice(1)); }
      } catch { /* binary or unreadable */ }
    }
    return new vscode.Hover(md, range);
  }
}

class WikiDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private index: LinkIndex) {}
  provideDefinition(doc: vscode.TextDocument, pos: vscode.Position) {
    const link = linkAt(doc, pos);
    const uri = link && this.index.resolve(link, doc.uri);
    if (!uri) { return undefined; }
    const wanted = link.heading && slugify(link.heading);
    const line = wanted ? this.index.note(uri)?.headings.find(h => slugify(h.text) === wanted)?.line ?? 0 : 0;
    return new vscode.Location(uri, new vscode.Position(line, 0));
  }
}

/** Dim unresolved [[links]] in the source editor so missing notes are easy to spot. */
function registerUnresolvedDecorations(ctx: vscode.ExtensionContext, index: LinkIndex) {
  const deco = vscode.window.createTextEditorDecorationType({ opacity: '0.6', textDecoration: 'underline dotted' });
  const update = (editor?: vscode.TextEditor) => {
    if (!editor || editor.document.languageId !== 'markdown') { return; }
    const ranges = (index.note(editor.document.uri) ?? parseNote(editor.document.getText())).links
      .filter(l => l.kind === 'wiki' && l.target && !index.resolve(l, editor.document.uri))
      .map(l => new vscode.Range(l.line, l.start, l.line, l.end));
    editor.setDecorations(deco, ranges);
  };
  ctx.subscriptions.push(deco,
    vscode.window.onDidChangeActiveTextEditor(update),
    index.onDidChange(() => vscode.window.visibleTextEditors.forEach(update)));
  void index.ready.then(() => update(vscode.window.activeTextEditor));
}

export function registerLinkFeatures(ctx: vscode.ExtensionContext, index: LinkIndex) {
  ctx.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider(MD, new WikiLinkProvider(index)),
    vscode.languages.registerCompletionItemProvider(MD, new WikiCompletionProvider(index), '[', '#'),
    vscode.languages.registerHoverProvider(MD, new WikiHoverProvider(index)),
    vscode.languages.registerDefinitionProvider(MD, new WikiDefinitionProvider(index)),
    vscode.commands.registerCommand('diamond.openLink', (args: OpenLinkArgs) => openLink(index, args)),
  );
  registerUnresolvedDecorations(ctx, index);
}
