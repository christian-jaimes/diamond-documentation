import * as vscode from 'vscode';
import * as path from 'path';
import { MARKDOWN_FILE, noteSignature, parseNote, ParsedLink, ParsedNote } from './parser';
import { globToRegExp } from './shared/glob';

export const isMarkdown = (uri: vscode.Uri) => MARKDOWN_FILE.test(uri.path);
export const stripMarkdownExt = (p: string) => p.replace(MARKDOWN_FILE, '');

const MARKDOWN_EXTS = ['.md', '.markdown', '.mdx'];
const stem = (p: string) => path.posix.basename(p, path.posix.extname(p));
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');
/** How long to wait after a keystroke before re-parsing an open note. */
const TYPING_DELAY = 250;

export interface Backlink { source: vscode.Uri; link: ParsedLink; }

export interface GraphNode { id: string; label: string; path: string; type: 'note' | 'file' | 'ghost'; group: string; tags: string[]; color?: string; }
export interface GraphEdge { source: string; target: string; }
export interface GraphData { nodes: GraphNode[]; edges: GraphEdge[]; }

interface ResolvedLink { source: vscode.Uri; link: ParsedLink; target?: vscode.Uri; }

/**
 * Keeps track of every file in the workspace and the links inside every
 * markdown file. Links are stored raw and resolved lazily (cached until the
 * next change), so creating a file immediately "fixes" links that pointed at it.
 */
export class LinkIndex implements vscode.Disposable {
  private files = new Map<string, vscode.Uri>();
  private byName = new Map<string, vscode.Uri[]>();   // "setup.md", "diagram.png"
  private byStem = new Map<string, vscode.Uri[]>();   // "setup" (markdown only)
  private notes = new Map<string, ParsedNote>();
  private signatures = new Map<string, string>();
  private resolveCache = new Map<string, vscode.Uri | null>();
  /** Every link resolved, plus links grouped by target; rebuilt lazily after a change. */
  private resolved: { all: ResolvedLink[]; incoming: Map<string, Backlink[]> } | undefined;
  private graphCache: GraphData | undefined;
  private exclude: RegExp | undefined;
  private typingTimers = new Map<string, NodeJS.Timeout>();
  private disposables: vscode.Disposable[] = [];
  private changeTimer: NodeJS.Timeout | undefined;
  private filesTimer: NodeJS.Timeout | undefined;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  private readonly _onDidChangeFiles = new vscode.EventEmitter<void>();
  /** Links or tags changed somewhere (debounced). */
  readonly onDidChange = this._onDidChange.event;
  /** Files were added, removed or renamed, so link targets may resolve differently (debounced). */
  readonly onDidChangeFiles = this._onDidChangeFiles.event;
  ready: Promise<void> = Promise.resolve();

  start() {
    this.ready = this.build();
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.disposables.push(
      watcher,
      watcher.onDidCreate(uri => this.addFile(uri, true)),
      watcher.onDidDelete(uri => this.removeFile(uri)),
      watcher.onDidChange(uri => { if (isMarkdown(uri) && !this.isOpenAndDirty(uri)) { void this.indexFromDisk(uri); } }),
      vscode.workspace.onDidChangeTextDocument(e => {
        const key = e.document.uri.toString();
        if (e.contentChanges.length === 0 || !this.notes.has(key)) { return; }
        clearTimeout(this.typingTimers.get(key));
        this.typingTimers.set(key, setTimeout(() => { this.typingTimers.delete(key); this.indexText(e.document.uri, e.document.getText()); }, TYPING_DELAY));
      }),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('diamond.exclude')) { void this.rebuild(); } }),
    );
  }

  rebuild() { this.ready = this.build(); return this.ready; }

  private async build() {
    this.files.clear(); this.byName.clear(); this.byStem.clear(); this.notes.clear(); this.signatures.clear();
    const cfg = vscode.workspace.getConfiguration('diamond');
    const exclude = cfg.get<string>('exclude') || undefined;
    this.exclude = exclude ? globToRegExp(exclude) : undefined;
    const uris = await vscode.workspace.findFiles('**/*', exclude, cfg.get<number>('maxFiles', 50000));
    for (const uri of uris) { this.addFile(uri, false); }
    // Read notes with bounded concurrency so huge workspaces do not flood the file system.
    const queue = uris.filter(isMarkdown);
    await Promise.all(Array.from({ length: Math.min(32, queue.length) }, async () => {
      for (let uri = queue.pop(); uri; uri = queue.pop()) { await this.indexFromDisk(uri, false); }
    }));
    this.changed(true);
  }

  private isOpenAndDirty(uri: vscode.Uri) {
    const key = uri.toString();
    return vscode.workspace.textDocuments.some(d => d.isDirty && d.uri.toString() === key);
  }

  private isExcluded(uri: vscode.Uri) {
    if (uri.scheme !== 'file' && uri.scheme !== 'vscode-vfs') { return true; }
    if (/\/(node_modules|\.git)\//.test(uri.path)) { return true; }
    return !!this.exclude?.test(vscode.workspace.asRelativePath(uri, false));
  }

  private addFile(uri: vscode.Uri, index: boolean) {
    const key = uri.toString();
    if (this.files.has(key) || this.isExcluded(uri)) { return; }
    this.files.set(key, uri);
    const push = (map: Map<string, vscode.Uri[]>, k: string) => { const a = map.get(k); a ? a.push(uri) : map.set(k, [uri]); };
    push(this.byName, path.posix.basename(uri.path).toLowerCase());
    if (isMarkdown(uri)) {
      push(this.byStem, stem(uri.path).toLowerCase());
      this.notes.set(key, { links: [], headings: [], tags: [] });
    }
    if (index) {
      if (isMarkdown(uri)) { void this.indexFromDisk(uri); }
      this.changed(true);
    }
  }

  /** Files at `uri` or below it (when `uri` is a folder). */
  filesUnder(uri: vscode.Uri): vscode.Uri[] {
    const key = uri.toString();
    const prefix = key.endsWith('/') ? key : key + '/';
    return [...this.files.entries()].filter(([k]) => k === key || k.startsWith(prefix)).map(([, u]) => u);
  }

  /** Apply a rename immediately (the file watcher would catch up later anyway). */
  renameFiles(pairs: { oldUri: vscode.Uri; newUri: vscode.Uri }[]) {
    for (const { oldUri, newUri } of pairs) {
      const note = this.notes.get(oldUri.toString());
      this.removeFile(oldUri, false);
      this.addFile(newUri, false);
      if (note) { this.notes.set(newUri.toString(), note); this.signatures.set(newUri.toString(), noteSignature(note)); }
    }
    this.changed(true);
  }

  private removeFile(uri: vscode.Uri, fire = true) {
    const key = uri.toString();
    // A deleted folder only fires one event: drop everything below it too.
    const prefix = key.endsWith('/') ? key : key + '/';
    let removed = false;
    for (const [k, u] of this.files) {
      if (k !== key && !k.startsWith(prefix)) { continue; }
      removed = true;
      this.files.delete(k);
      this.notes.delete(k);
      this.signatures.delete(k);
      const drop = (map: Map<string, vscode.Uri[]>, n: string) => {
        const a = map.get(n)?.filter(x => x.toString() !== k);
        a && a.length ? map.set(n, a) : map.delete(n);
      };
      drop(this.byName, path.posix.basename(u.path).toLowerCase());
      drop(this.byStem, stem(u.path).toLowerCase());
    }
    if (removed && fire) { this.changed(true); }
  }

  private async indexFromDisk(uri: vscode.Uri, fire = true) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      this.indexText(uri, Buffer.from(bytes).toString('utf8'), fire);
    } catch { /* file vanished */ }
  }

  /**
   * Re-read every open note from its current text, so link positions are exact
   * (pending typing delays or a file-watcher lag can otherwise leave them behind).
   * Used right before links are rewritten on rename; only open documents are touched.
   */
  syncOpenDocuments() {
    this.typingTimers.forEach(clearTimeout);
    this.typingTimers.clear();
    for (const doc of vscode.workspace.textDocuments) {
      if (this.notes.has(doc.uri.toString())) { this.indexText(doc.uri, doc.getText()); }
    }
  }

  /** Re-parse a note. Listeners are only told when its links or tags actually changed. */
  indexText(uri: vscode.Uri, text: string, fire = true) {
    const key = uri.toString();
    const note = parseNote(text);
    this.notes.set(key, note);
    this.resolved = undefined; // link positions moved even if the targets did not
    const sig = noteSignature(note);
    if (this.signatures.get(key) === sig) { return; }
    this.signatures.set(key, sig);
    if (fire) { this.changed(false); }
  }

  private changed(filesChanged: boolean) {
    this.resolved = undefined;
    this.graphCache = undefined;
    if (filesChanged) {
      this.resolveCache.clear();
      clearTimeout(this.filesTimer);
      this.filesTimer = setTimeout(() => this._onDidChangeFiles.fire(), 300);
    }
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this._onDidChange.fire(), 300);
  }

  // ---------------------------------------------------------------- queries

  allFiles(): vscode.Uri[] { return [...this.files.values()]; }
  note(uri: vscode.Uri): ParsedNote | undefined { return this.notes.get(uri.toString()); }

  /** Shortest unambiguous wikilink text for a file: the bare name, or the path when names collide. */
  linkTextFor(uri: vscode.Uri): string {
    const md = isMarkdown(uri);
    const short = md ? stem(uri.path) : path.posix.basename(uri.path);
    const candidates = (md ? this.byStem : this.byName).get(short.toLowerCase()) ?? [];
    if (candidates.length <= 1) { return short; }
    const rel = this.relativePath(uri);
    return md ? stripMarkdownExt(rel) : rel;
  }

  relativePath(uri: vscode.Uri): string {
    return norm(vscode.workspace.asRelativePath(uri, (vscode.workspace.workspaceFolders?.length ?? 0) > 1));
  }

  /** Resolve a link target (wiki or markdown) written inside `from`. */
  resolve(link: Pick<ParsedLink, 'target' | 'kind'>, from: vscode.Uri): vscode.Uri | undefined {
    const target = norm(link.target.trim());
    if (!target) { return from; } // [[#heading]] → same file
    const key = `${from.toString()}|${link.kind}|${target}`;
    const cached = this.resolveCache.get(key);
    if (cached !== undefined) { return cached ?? undefined; }
    const result = this.doResolve(target, link.kind, from);
    this.resolveCache.set(key, result ?? null);
    return result;
  }

  private doResolve(target: string, kind: ParsedLink['kind'], from: vscode.Uri): vscode.Uri | undefined {
    const lookup = (base: vscode.Uri, rel: string) => {
      for (const ext of ['', ...MARKDOWN_EXTS]) {
        const hit = this.files.get(vscode.Uri.joinPath(base, rel + ext).toString());
        if (hit) { return hit; }
      }
      return undefined;
    };
    const roots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri);
    const bases: [vscode.Uri, string][] = target.startsWith('/')
      ? roots.map(r => [r, target.slice(1)])
      : [[vscode.Uri.joinPath(from, '..'), target], ...roots.map(r => [r, target] as [vscode.Uri, string])];
    for (const [base, rel] of bases) {
      const hit = lookup(base, rel);
      if (hit) { return hit; }
    }
    if (kind === 'markdown') { return undefined; }

    // Wikilink: look up by file name anywhere in the workspace.
    const base = path.posix.basename(target).toLowerCase();
    let candidates = this.byName.get(base) ?? this.byStem.get(base) ?? [];
    if (!candidates.length) { return undefined; }
    if (target.includes('/')) {
      const suffix = '/' + target.toLowerCase();
      const bySuffix = candidates.filter(c => { const p = c.path.toLowerCase(); return p.endsWith(suffix) || stripMarkdownExt(p).endsWith(suffix); });
      if (bySuffix.length) { candidates = bySuffix; }
    }
    // Prefer the file closest to the source note.
    return candidates.length === 1 ? candidates[0] : [...candidates].sort((a, b) => distance(from, a) - distance(from, b))[0];
  }

  private resolveAll() {
    if (!this.resolved) {
      const all: ResolvedLink[] = [];
      const incoming = new Map<string, Backlink[]>();
      for (const [src, note] of this.notes) {
        const source = this.files.get(src);
        if (!source) { continue; }
        for (const link of note.links) {
          if (!link.target) { continue; }
          const target = this.resolve(link, source);
          all.push({ source, link, target });
          if (target) {
            const k = target.toString();
            const list = incoming.get(k);
            list ? list.push({ source, link }) : incoming.set(k, [{ source, link }]);
          }
        }
      }
      this.resolved = { all, incoming };
    }
    return this.resolved;
  }

  backlinks(uri: vscode.Uri): Backlink[] {
    return this.resolveAll().incoming.get(uri.toString()) ?? [];
  }

  /** Notes, linked files and unresolved link targets, with the links between them (cached). */
  graph(): GraphData {
    if (this.graphCache) { return this.graphCache; }
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const nodeFor = (uri: vscode.Uri): string => {
      const id = uri.toString();
      if (!nodes.has(id)) {
        const rel = this.relativePath(uri);
        const note = isMarkdown(uri);
        nodes.set(id, { id, label: note ? stem(uri.path) : path.posix.basename(uri.path), path: rel, type: note ? 'note' : 'file', group: rel.includes('/') ? rel.split('/')[0] : '/', tags: this.notes.get(id)?.tags ?? [] });
      }
      return id;
    };
    for (const [key, uri] of this.files) { if (this.notes.has(key)) { nodeFor(uri); } }
    for (const { source, link, target } of this.resolveAll().all) {
      let targetId: string;
      if (target) {
        targetId = nodeFor(target);
      } else {
        if (link.kind !== 'wiki') { continue; }
        targetId = 'ghost:' + link.target.toLowerCase();
        if (!nodes.has(targetId)) { nodes.set(targetId, { id: targetId, label: link.target, path: `${link.target} (not created yet)`, type: 'ghost', group: '__ghost', tags: [] }); }
      }
      const sourceId = source.toString();
      if (targetId !== sourceId) { edges.set(`${sourceId}→${targetId}`, { source: sourceId, target: targetId }); }
    }
    this.graphCache = { nodes: [...nodes.values()], edges: [...edges.values()] };
    return this.graphCache;
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
    this.typingTimers.forEach(clearTimeout);
    this._onDidChange.dispose();
    this._onDidChangeFiles.dispose();
  }
}

function distance(a: vscode.Uri, b: vscode.Uri): number {
  const pa = a.path.split('/'), pb = b.path.split('/');
  let i = 0;
  while (i < pa.length - 1 && i < pb.length - 1 && pa[i] === pb[i]) { i++; }
  return (pa.length - 1 - i) + (pb.length - 1 - i);
}
