import * as vscode from 'vscode';
import { ColorConfig, colorFor, parseColorConfig, templateYaml } from './shared/colors';
import type { GraphData } from './linkIndex';

const FILES = ['graph.yml', 'graph.yaml', 'graph.json'];

/** Loads `.diamond/graph.yml` from each workspace folder and keeps it up to date. */
export class GraphColors implements vscode.Disposable {
  private configs = new Map<string, ColorConfig>(); // workspace folder name → config
  private colored: { source: GraphData; result: GraphData } | undefined;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private disposables: vscode.Disposable[] = [];
  private diagnostics = vscode.languages.createDiagnosticCollection('diamond');

  start() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/.diamond/graph.{yml,yaml,json}');
    const reload = () => void this.load();
    this.disposables.push(watcher, watcher.onDidChange(reload), watcher.onDidCreate(reload), watcher.onDidDelete(reload),
      vscode.workspace.onDidChangeWorkspaceFolders(reload), this.diagnostics, this._onDidChange);
    return this.load();
  }

  private async load() {
    this.configs.clear();
    this.diagnostics.clear();
    this.colored = undefined;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      for (const name of FILES) {
        const uri = vscode.Uri.joinPath(folder.uri, '.diamond', name);
        let text: string;
        try { text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'); } catch { continue; }
        const cfg = parseColorConfig(text);
        this.configs.set(folder.name, cfg);
        if (cfg.errors.length) {
          this.diagnostics.set(uri, cfg.errors.map(e => new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), e, vscode.DiagnosticSeverity.Warning)));
        }
        break;
      }
    }
    this._onDidChange.fire();
  }

  /** The graph with configured colours applied (cached per graph). */
  apply(graph: GraphData): GraphData {
    if (!this.configs.size) { return graph; }
    if (this.colored?.source === graph) { return this.colored.result; }
    const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const single = this.configs.values().next().value as ColorConfig;
    const nodes = graph.nodes.map(n => {
      // Node paths are workspace-relative; with several folders they start with the folder name.
      let cfg = single, rel = n.path;
      if (multiRoot) {
        const slash = n.path.indexOf('/');
        cfg = this.configs.get(n.path.slice(0, slash))!;
        rel = n.path.slice(slash + 1);
      }
      const color = cfg && colorFor(cfg, rel, n.type);
      return color ? { ...n, color } : n;
    });
    this.colored = { source: graph, result: { nodes, edges: graph.edges } };
    return this.colored.result;
  }

  legend(): { label: string; color: string }[] {
    return [...this.configs.values()].flatMap(c => c.rules.map(r => ({ label: r.label, color: r.color })));
  }

  /** Create `.diamond/graph.yml` (pre-filled with the top-level folders) and open it. */
  async configure() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { vscode.window.showWarningMessage('Open a folder first.'); return; }
    for (const name of FILES) {
      const existing = vscode.Uri.joinPath(folder.uri, '.diamond', name);
      try { await vscode.workspace.fs.stat(existing); await vscode.window.showTextDocument(existing); return; } catch { /* create below */ }
    }
    const entries = await vscode.workspace.fs.readDirectory(folder.uri);
    const folders = entries.filter(([n, t]) => t === vscode.FileType.Directory && !n.startsWith('.') && n !== 'node_modules').map(([n]) => n).sort();
    const uri = vscode.Uri.joinPath(folder.uri, '.diamond', 'graph.yml');
    await vscode.workspace.fs.writeFile(uri, Buffer.from(templateYaml(folders)));
    await vscode.window.showTextDocument(uri);
  }

  dispose() { this.disposables.forEach(d => d.dispose()); }
}
