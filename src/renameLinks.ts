import * as vscode from 'vscode';
import * as path from 'path';
import { LinkIndex, isMarkdown, stripMarkdownExt } from './linkIndex';
import { MARKDOWN_FILE, ParsedLink } from './parser';

interface Job {
  /** Note containing the link (before the rename). */
  source: vscode.Uri;
  link: ParsedLink;
  /** File the link points to (after the rename). */
  target: vscode.Uri;
}

/** Windows paths can differ only in drive-letter case (`/C:/` vs `/c:/`). */
const normPath = (p: string) => p.replace(/^\/([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}:`);

/**
 * Keeps links working when files or folders are renamed or moved:
 *  - [[wikilinks]] and [markdown](links) pointing at a moved file are rewritten,
 *  - relative [markdown](links) inside a moved note are re-based,
 * and the touched files are saved, without asking.
 */
export function registerRenameHandling(ctx: vscode.ExtensionContext, index: LinkIndex) {
  let jobs: Job[] = [];
  let pairs: { oldUri: vscode.Uri; newUri: vscode.Uri }[] = [];

  ctx.subscriptions.push(
    vscode.workspace.onWillRenameFiles(e => {
      jobs = []; pairs = [];
      if (!vscode.workspace.getConfiguration('diamond').get<boolean>('updateLinksOnRename', true)) { return; }
      index.syncOpenDocuments(); // link positions must reflect the latest edits

      // Expand folder renames into one pair per indexed file.
      for (const { oldUri, newUri } of e.files) {
        for (const file of index.filesUnder(oldUri)) {
          const suffix = file.path.slice(oldUri.path.length);
          pairs.push({ oldUri: file, newUri: newUri.with({ path: newUri.path + suffix }) });
        }
      }
      const moved = new Map(pairs.map(p => [p.oldUri.toString(), p.newUri]));
      const seen = new Set<string>();
      const add = (job: Job) => {
        const key = `${job.source}|${job.link.line}|${job.link.start}`;
        if (!seen.has(key)) { seen.add(key); jobs.push(job); }
      };

      for (const { oldUri, newUri } of pairs) {
        // Links pointing at the moved file.
        for (const { source, link } of index.backlinks(oldUri)) {
          if (link.target) { add({ source, link, target: newUri }); }
        }
        // Relative markdown links inside a moved note.
        if (isMarkdown(oldUri)) {
          for (const link of index.note(oldUri)?.links ?? []) {
            if (link.kind !== 'markdown' || !link.target || link.target.startsWith('/')) { continue; }
            const resolved = index.resolve(link, oldUri);
            if (resolved) { add({ source: oldUri, link, target: moved.get(resolved.toString()) ?? resolved }); }
          }
        }
      }
    }),

    vscode.workspace.onDidRenameFiles(async () => {
      if (!pairs.length) { return; }
      const todo = jobs, renamed = pairs;
      jobs = []; pairs = [];
      index.renameFiles(renamed);
      if (!todo.length) { return; }

      const moved = new Map(renamed.map(p => [p.oldUri.toString(), p.newUri]));
      const edit = new vscode.WorkspaceEdit();
      const touched = new Map<string, vscode.Uri>();
      for (const job of todo) {
        const source = moved.get(job.source.toString()) ?? job.source;
        const text = job.link.kind === 'wiki' ? wikiText(index, job) : markdownText(job, source);
        edit.replace(source, new vscode.Range(job.link.line, job.link.targetStart, job.link.line, job.link.targetEnd), text);
        touched.set(source.toString(), source);
      }
      const wasDirty = new Set(vscode.workspace.textDocuments.filter(d => d.isDirty).map(d => d.uri.toString()));
      if (!(await vscode.workspace.applyEdit(edit))) { return; }
      // Save what we changed, but leave files that already had unsaved work for the user.
      await Promise.all([...touched.values()].filter(u => !wasDirty.has(u.toString())).map(async u => {
        const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === u.toString());
        await doc?.save();
      }));
      vscode.window.setStatusBarMessage(`$(link) Updated ${todo.length} link(s) in ${touched.size} file(s)`, 4000);
    }),
  );
}

function wikiText(index: LinkIndex, job: Job): string {
  const old = job.link.target;
  let text = index.linkTextFor(job.target);
  if (old.includes('/') && !text.includes('/')) {
    // The note was linked by path: keep using a path.
    text = index.relativePath(job.target);
    if (isMarkdown(job.target)) { text = stripMarkdownExt(text); }
  }
  // [[note.md]] keeps its extension.
  if (MARKDOWN_FILE.test(old) && isMarkdown(job.target) && !MARKDOWN_FILE.test(text)) { text += path.posix.extname(job.target.path); }
  return text;
}

function markdownText(job: Job, source: vscode.Uri): string {
  // The range covers the whole destination, e.g. `<../a b.md#x>` or `../a%20b.md#x`.
  let rel = path.posix.relative(path.posix.dirname(normPath(source.path)), normPath(job.target.path)) || path.posix.basename(job.target.path);
  if (!rel.startsWith('.') && job.link.target.startsWith('./')) { rel = './' + rel; }
  const wasAngle = job.link.raw?.startsWith('<') ?? false;
  const hash = job.link.heading !== undefined ? '#' + job.link.heading : '';
  if (wasAngle) { return `<${rel}${hash}>`; }
  return encodeURI(rel).replace(/#/g, '%23') + hash;
}
