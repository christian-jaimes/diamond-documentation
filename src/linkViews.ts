import * as vscode from 'vscode';
import { LinkIndex } from './linkIndex';
import { activeTabUri } from './webviewUtil';

type Item =
  | { kind: 'file'; uri: vscode.Uri; count: number; children: Item[]; missing?: boolean }
  | { kind: 'line'; uri: vscode.Uri; line: number; text: string };

/** Side bar views: "Backlinks" (who links here) and "Outgoing Links" (what this file links to). */
class LinksTree implements vscode.TreeDataProvider<Item> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private index: LinkIndex, private mode: 'backlinks' | 'outgoing') {}
  refresh() { this._onDidChange.fire(); }

  getTreeItem(item: Item): vscode.TreeItem {
    if (item.kind === 'file') {
      const state = item.children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None;
      const t = item.missing ? new vscode.TreeItem(item.uri.path.split('/').pop()!, state) : new vscode.TreeItem(item.uri, state);
      t.description = item.missing ? 'not created yet' : `${this.index.relativePath(item.uri)} · ${item.count}`;
      t.iconPath = item.missing ? new vscode.ThemeIcon('circle-outline') : vscode.ThemeIcon.File;
      if (!item.missing) { t.command = { command: 'vscode.open', title: 'Open', arguments: [item.uri] }; }
      return t;
    }
    const t = new vscode.TreeItem(item.text, vscode.TreeItemCollapsibleState.None);
    t.tooltip = item.text;
    t.iconPath = new vscode.ThemeIcon('link');
    t.command = { command: 'vscode.open', title: 'Open', arguments: [item.uri, { selection: new vscode.Range(item.line, 0, item.line, 0) }] };
    return t;
  }

  getChildren(item?: Item): Item[] {
    if (item) { return item.kind === 'file' ? item.children : []; }
    const current = activeTabUri(); // text editor or live editor
    if (!current) { return []; }
    const groups = new Map<string, Item & { kind: 'file' }>();

    if (this.mode === 'backlinks') {
      for (const { source, link } of this.index.backlinks(current)) {
        if (source.toString() === current.toString()) { continue; }
        let g = groups.get(source.toString());
        if (!g) { g = { kind: 'file', uri: source, count: 0, children: [] }; groups.set(source.toString(), g); }
        g.count++;
        g.children.push({ kind: 'line', uri: source, line: link.line, text: link.context });
      }
    } else {
      for (const link of this.index.note(current)?.links ?? []) {
        if (!link.target) { continue; }
        const resolved = this.index.resolve(link, current);
        const uri = resolved ?? vscode.Uri.joinPath(current, '..', link.target);
        let g = groups.get(uri.toString());
        if (!g) { g = { kind: 'file', uri, count: 0, children: [], missing: !resolved }; groups.set(uri.toString(), g); }
        g.count++;
      }
    }
    return [...groups.values()].sort((a, b) => b.count - a.count);
  }
}

export function registerLinkViews(ctx: vscode.ExtensionContext, index: LinkIndex) {
  const back = new LinksTree(index, 'backlinks');
  const out = new LinksTree(index, 'outgoing');
  const refresh = () => { back.refresh(); out.refresh(); };
  let shown = activeTabUri()?.toString();
  ctx.subscriptions.push(
    vscode.window.createTreeView('diamond.backlinks', { treeDataProvider: back }),
    vscode.window.createTreeView('diamond.outgoing', { treeDataProvider: out }),
    // Refresh when the active file changes (tab events also fire for moves, pins, etc.).
    vscode.window.tabGroups.onDidChangeTabs(() => { const uri = activeTabUri()?.toString(); if (uri !== shown) { shown = uri; refresh(); } }),
    index.onDidChange(refresh),
    vscode.commands.registerCommand('diamond.refreshBacklinks', refresh),
  );
}
