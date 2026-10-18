import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type MarkdownIt from 'markdown-it';
import { LinkIndex, isMarkdown } from './linkIndex';
import { IMAGE, splitWikiTarget, slugify } from './parser';

const MAX_EMBED_DEPTH = 2;

/**
 * markdown-it plugin for VS Code's built-in preview:
 *   [[wikilinks]]  ![[embeds]]  ==highlight==  - [ ] task checkboxes
 */
export function diamondMarkdownIt(md: MarkdownIt, index: LinkIndex): MarkdownIt {
  let embedDepth = 0;

  md.inline.ruler.before('link', 'diamond_wikilink', (state, silent) => {
    const src = state.src;
    let pos = state.pos;
    const embed = src.charCodeAt(pos) === 0x21 /* ! */;
    if (embed) { pos++; }
    if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) { return false; }
    const close = src.indexOf(']]', pos + 2);
    if (close < 0) { return false; }
    const inner = src.slice(pos + 2, close);
    if (!inner || /[\[\]\n]/.test(inner)) { return false; }
    if (!silent) {
      const t = state.push('diamond_wikilink', '', 0);
      t.meta = { inner, embed };
    }
    state.pos = close + 2;
    return true;
  });

  md.renderer.rules.diamond_wikilink = (tokens, idx, _opts, env) => {
    const { inner, embed } = tokens[idx].meta as { inner: string; embed: boolean };
    const { target, heading, alias } = splitWikiTarget(inner);
    const current: vscode.Uri | undefined = env?.currentDocument;
    const resolved = current ? index.resolve({ target, kind: 'wiki' }, current) : undefined;
    const label = md.utils.escapeHtml(alias || (heading ? (target ? `${target} › ${heading}` : heading) : target));
    const href = (uri: vscode.Uri) => {
      const rel = current ? path.posix.relative(path.posix.dirname(current.path), uri.path) : uri.path;
      return encodeURI(rel || path.posix.basename(uri.path)) + (heading ? '#' + slugify(heading) : '');
    };

    if (!resolved) {
      const fallback = encodeURI(path.posix.extname(target) ? target : `${target}.md`);
      return `<a class="diamond-link diamond-unresolved" href="${fallback}" title="Not created yet">${label}</a>`;
    }
    if (embed && IMAGE.test(resolved.path)) {
      const size = alias && /^\d+(x\d+)?$/.test(alias) ? ` width="${alias.split('x')[0]}"` : '';
      return `<img class="diamond-embed-img" src="${href(resolved)}" alt="${md.utils.escapeHtml(target)}"${size}>`;
    }
    if (embed && embedDepth < MAX_EMBED_DEPTH && resolved.scheme === 'file') {
      try {
        let text = fs.readFileSync(resolved.fsPath, 'utf8');
        if (!isMarkdown(resolved)) {
          text = '```' + path.extname(resolved.path).slice(1) + '\n' + text + '\n```';
        } else if (heading) {
          text = extractSection(text, heading);
        }
        embedDepth++;
        const html = md.render(text, { ...env, currentDocument: resolved });
        embedDepth--;
        return `<div class="diamond-embed"><div class="diamond-embed-title"><a href="${href(resolved)}">${md.utils.escapeHtml(path.posix.basename(resolved.path))}</a></div>${html}</div>`;
      } catch { embedDepth = Math.max(0, embedDepth - 1); }
    }
    return `<a class="diamond-link" href="${href(resolved)}" title="${md.utils.escapeHtml(index.relativePath(resolved))}">${label}</a>`;
  };

  // ==highlight==
  md.inline.ruler.before('emphasis', 'diamond_highlight', (state, silent) => {
    const src = state.src, start = state.pos;
    if (src.charCodeAt(start) !== 0x3d || src.charCodeAt(start + 1) !== 0x3d) { return false; }
    const end = src.indexOf('==', start + 2);
    if (end < 0 || end === start + 2 || /\s/.test(src[start + 2]) || /\s/.test(src[end - 1])) { return false; }
    if (!silent) {
      state.push('mark_open', 'mark', 1);
      const oldMax = state.posMax;
      state.pos = start + 2; state.posMax = end;
      state.md.inline.tokenize(state);
      state.posMax = oldMax;
      state.push('mark_close', 'mark', -1);
    }
    state.pos = end + 2;
    return true;
  });

  // - [ ] / - [x] task list items
  md.core.ruler.after('inline', 'diamond_tasks', (state) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') { continue; }
      const m = /^\[([ xX])\]\s/.exec(t.content);
      if (!m || !t.children?.length || t.children[0].type !== 'text') { continue; }
      const first = t.children[0];
      first.content = first.content.replace(/^\[[ xX]\]\s/, '');
      const box = new state.Token('html_inline', '', 0);
      box.content = `<input type="checkbox" class="diamond-task" disabled${m[1] !== ' ' ? ' checked' : ''}> `;
      t.children.unshift(box);
      tokens[i - 2].attrJoin('class', 'diamond-task-item' + (m[1] !== ' ' ? ' done' : ''));
    }
  });

  return md;
}

function extractSection(text: string, heading: string): string {
  const lines = text.split(/\r?\n/);
  const want = slugify(heading);
  const start = lines.findIndex(l => { const m = /^(#{1,6})\s+(.*)/.exec(l); return !!m && slugify(m[2]) === want; });
  if (start < 0) { return text; }
  const level = /^(#+)/.exec(lines[start])![1].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s/.exec(lines[i]);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}
