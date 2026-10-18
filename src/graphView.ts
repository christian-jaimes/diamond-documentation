import * as vscode from 'vscode';
import { LinkIndex } from './linkIndex';
import { openLink } from './linkFeatures';
import { GraphColors } from './colorConfig';
import { activeTabUri, nonce } from './webviewUtil';

interface GraphOptions {
  local: boolean;
  compact: boolean;
  depth?: number;
  /** Apply `local`/`depth` even if the view remembers a different choice. */
  force?: boolean;
  onFocus?: (uri: vscode.Uri) => void;
}

/** Wires a webview (editor panel or side bar view) to the link graph. */
class GraphController implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private lastActive = activeTabUri();
  /** Data changed while the view was hidden; send it when it is shown again. */
  private stale = false;

  constructor(private webview: vscode.Webview, extUri: vscode.Uri, private index: LinkIndex, private colors: GraphColors,
    private opts: GraphOptions, private isVisible: () => boolean, onDidChangeVisibility: vscode.Event<unknown>) {
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extUri, 'media'), vscode.Uri.joinPath(extUri, 'dist')] };
    webview.html = graphHtml(webview, extUri, opts.compact);
    const refresh = () => this.sendData();

    this.disposables.push(
      webview.onDidReceiveMessage(async msg => {
        switch (msg.type) {
          case 'ready': {
            await this.index.ready;
            const cfg = vscode.workspace.getConfiguration('diamond.graph');
            this.post({ type: 'mode', local: opts.local, depth: opts.depth, force: opts.force, focus: this.lastActive?.toString(), showFiles: cfg.get('showFiles'), showOrphans: cfg.get('showOrphans') });
            this.stale = true;
            this.sendData();
            break;
          }
          case 'open':
            if (String(msg.id).startsWith('ghost:')) {
              // Unresolved link: create the note next to the active file (or at the workspace root).
              const root = vscode.workspace.workspaceFolders?.[0]?.uri;
              const from = this.lastActive ?? (root && vscode.Uri.joinPath(root, 'index.md'));
              if (from) { await openLink(this.index, { from: from.toString(), target: msg.label, kind: 'wiki' }, { beside: true }); }
            } else {
              await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(msg.id), msg.beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.One);
            }
            break;
          case 'configureColors':
            await vscode.commands.executeCommand('diamond.configureGraphColors');
            break;
        }
      }),
      this.index.onDidChange(() => { this.stale = true; refresh(); }),
      this.colors.onDidChange(() => { this.stale = true; refresh(); }),
      onDidChangeVisibility(refresh),
      // Text and live editors alike: follow the active tab.
      vscode.window.tabGroups.onDidChangeTabs(() => { const uri = activeTabUri(); if (uri) { this.setActive(uri); } }),
    );
  }

  private setActive(uri: vscode.Uri) {
    if (uri.scheme !== 'file' || uri.toString() === this.lastActive?.toString()) { return; }
    this.lastActive = uri;
    this.opts.onFocus?.(uri);
    this.post({ type: 'focus', focus: uri.toString() });
  }

  get active() { return this.lastActive; }
  setLocal(local: boolean) { this.post({ type: 'mode', local, force: true, focus: this.lastActive?.toString() }); }

  private sendData() {
    if (!this.stale || !this.isVisible()) { return; }
    this.stale = false;
    this.post({ type: 'data', graph: this.colors.apply(this.index.graph()), legend: this.colors.legend() });
  }

  private post(msg: unknown) { void this.webview.postMessage(msg); }
  dispose() { this.disposables.forEach(d => d.dispose()); }
}

function graphHtml(w: vscode.Webview, extUri: vscode.Uri, compact: boolean): string {
  const script = w.asWebviewUri(vscode.Uri.joinPath(extUri, 'dist', 'graph.js'));
  const style = w.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', 'graph.css'));
  const n = nonce();
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style}" rel="stylesheet"><title>Graph</title></head>
<body class="${compact ? 'compact' : ''}">
  <div id="toolbar">
    <input id="search" type="search" placeholder="Filter (name, path or #tag)…">
    <button id="toggleFilters" class="icon" title="Filters">☰</button>
    <div id="filters">
      <label title="Show only what is within N links of the active file"><input id="local" type="checkbox" checked> Local</label>
      <label id="depthWrap" title="Local graph depth">Depth <input id="depth" type="range" min="1" max="5" value="2"><span id="depthVal">2</span></label>
      <label title="Markdown documentation"><input id="docs" type="checkbox" checked> Docs</label>
      <label title="Linked files of any type (squares)"><input id="files" type="checkbox" checked> Files</label>
      <label title="Links to notes that do not exist yet"><input id="ghosts" type="checkbox" checked> Unresolved</label>
      <label title="Notes without links"><input id="orphans" type="checkbox" checked> Orphans</label>
      <label><input id="labels" type="checkbox" checked> Labels</label>
      <label title="Colour legend from .diamond/graph.yml"><input id="showLegend" type="checkbox"> Legend</label>
      <button id="fit" title="Fit graph to view">Fit</button>
      <button id="colors" title="Edit folder colours (.diamond/graph.yml)">Colours…</button>
      ${compact ? '' : '<span id="stats"></span>'}
    </div>
  </div>
  <canvas id="graph"></canvas>
  <div id="legend"></div>
  <div id="empty" style="display:none"></div>
  <div id="tooltip"></div>
  ${compact ? '<span id="stats" class="corner"></span>' : '<div id="help">Click: open · Ctrl/Cmd+Click: open beside · Drag: move · Wheel: zoom</div>'}
  <script nonce="${n}" src="${script}"></script>
</body></html>`;
}

/** Graph in an editor tab. */
export class GraphPanel {
  private static current: GraphPanel | undefined;

  /** `forceLocal`: open as a local graph of the active file. Otherwise Local follows the view's last choice (on by default). */
  static show(ctx: vscode.ExtensionContext, index: LinkIndex, colors: GraphColors, forceLocal: boolean) {
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal();
      if (forceLocal) { GraphPanel.current.controller.setLocal(true); }
      return;
    }
    const panel = vscode.window.createWebviewPanel('diamond.graph', forceLocal ? 'Local Graph' : 'Graph View',
      { viewColumn: forceLocal ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active, preserveFocus: forceLocal },
      { enableScripts: true, retainContextWhenHidden: true });
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.png');
    const controller = new GraphController(panel.webview, ctx.extensionUri, index, colors, { local: true, compact: false, force: forceLocal },
      () => panel.visible, panel.onDidChangeViewState);
    GraphPanel.current = new GraphPanel(panel, controller);
  }

  private constructor(private panel: vscode.WebviewPanel, private controller: GraphController) {
    panel.onDidDispose(() => { GraphPanel.current = undefined; controller.dispose(); });
  }
}

/** Graph in the Diamond side bar: follows the open file (its outgoing links and backlinks). */
export class GraphSidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'diamond.graphView';
  constructor(private ctx: vscode.ExtensionContext, private index: LinkIndex, private colors: GraphColors) {}

  resolveWebviewView(view: vscode.WebviewView) {
    const describe = (uri?: vscode.Uri) => { view.description = uri?.path.split('/').pop(); };
    const controller = new GraphController(view.webview, this.ctx.extensionUri, this.index, this.colors,
      { local: true, depth: 1, compact: true, onFocus: describe }, () => view.visible, view.onDidChangeVisibility);
    describe(controller.active);
    view.onDidDispose(() => controller.dispose());
  }
}
