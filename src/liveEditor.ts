import * as vscode from 'vscode';
import { LinkIndex } from './linkIndex';
import { openLink } from './linkFeatures';
import { IMAGE } from './parser';
import { nonce } from './webviewUtil';
import type { FormatMessage, LiveTarget } from './formatting';

/** An edit from the webview, as line/column positions (identical for "\n" and "\r\n" files). */
interface LineChange { fl: number; fc: number; tl: number; tc: number; insert: string; }

export interface LiveSelection { line: number; col: number; selWords: number; selChars: number; }
interface Session { panel: vscode.WebviewPanel; document: vscode.TextDocument; ready: boolean; selection?: LiveSelection; }

/** Commands the live editor toolbar may run. */
const TOOLBAR_COMMANDS = new Set(['diamond.insertLink', 'diamond.insertCodeBlock', 'diamond.insertTable', 'diamond.formatTable']);

/**
 * Editable, formatted view of a Markdown file (a custom text editor backed by
 * the normal TextDocument, so saving, dirty state, Git and the source editor
 * all keep working).
 */
export class LiveEditorProvider implements vscode.CustomTextEditorProvider, LiveTarget {
  static readonly viewType = 'diamond.liveEditor';
  private sessions = new Set<Session>();
  private pendingReveals = new Map<string, number>();
  private readonly _onDidChangeActive = new vscode.EventEmitter<void>();
  /** Fires when the focused live editor or its cursor changes (used by the status bar). */
  readonly onDidChangeActive = this._onDidChangeActive.event;

  constructor(private ctx: vscode.ExtensionContext, private index: LinkIndex) {}

  static register(ctx: vscode.ExtensionContext, index: LinkIndex): LiveEditorProvider {
    const provider = new LiveEditorProvider(ctx, index);
    ctx.subscriptions.push(
      vscode.window.registerCustomEditorProvider(LiveEditorProvider.viewType, provider, {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      }),
      vscode.commands.registerCommand('diamond.toggleLiveEditorDefault', async () => {
        const cfg = vscode.workspace.getConfiguration('diamond.liveEditor');
        const on = !cfg.get<boolean>('openByDefault', true);
        await cfg.update('openByDefault', on, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(on ? 'Markdown files now open in the Diamond live editor.' : 'Markdown files now open in the source editor.');
      }),
      provider._onDidChangeActive,
      // Clipboard for the focused live editor (the keyboard shortcuts are handled inside the editor itself).
      ...(['copy', 'cut', 'paste'] as const).map(action => vscode.commands.registerCommand(`diamond.live${action[0].toUpperCase()}${action.slice(1)}`, () => {
        const s = provider.active() as Session | undefined;
        if (s) { void s.panel.webview.postMessage({ type: 'clipboard', action }); }
      })),
      // Internal (used by the integration tests): images rendered in the focused live editor.
      vscode.commands.registerCommand('diamond._probeLiveEditor', (select?: [number, number]) => provider.probe(select)),
    );
    return provider;
  }

  private probeWaiter: ((images: unknown) => void) | undefined;

  private probe(select?: [number, number]): Promise<unknown> {
    const s = this.active() as Session | undefined;
    if (!s) { return Promise.resolve(undefined); }
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.probeWaiter = undefined; resolve(undefined); }, 3000);
      this.probeWaiter = images => { clearTimeout(timer); this.probeWaiter = undefined; resolve(images); };
      void s.panel.webview.postMessage({ type: 'probe', select });
    });
  }

  /** The document and cursor of the focused live editor, if any. */
  active(): { document: vscode.TextDocument; selection?: LiveSelection } | undefined {
    for (const s of this.sessions) { if (s.panel.active) { return s; } }
    return undefined;
  }

  /** LiveTarget: forward a formatting command to the focused live editor. */
  format(msg: FormatMessage): boolean {
    const s = this.active() as Session | undefined;
    if (!s) { return false; }
    void s.panel.webview.postMessage({ type: 'format', format: msg });
    return true;
  }

  /** Scroll a live editor to `line` once it is open (used when following [[note#heading]] links). */
  revealWhenOpen(uri: vscode.Uri, line: number) {
    const key = uri.toString();
    const open = [...this.sessions].find(s => s.ready && s.document.uri.toString() === key);
    if (open) { void open.panel.webview.postMessage({ type: 'reveal', line }); }
    else { this.pendingReveals.set(key, line); }
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const ext = this.ctx.extensionUri;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(ext, 'media'), vscode.Uri.joinPath(ext, 'dist'), ...(vscode.workspace.workspaceFolders ?? []).map(f => f.uri), vscode.Uri.joinPath(document.uri, '..')],
    };
    panel.webview.html = this.html(panel.webview);

    const session: Session = { panel, document, ready: false };
    this.sessions.add(session);
    const key = document.uri.toString();
    const post = (msg: unknown) => void panel.webview.postMessage(msg);

    // Sync protocol: every full text we send carries a sequence number; the webview
    // echoes the latest one with its edits, so edits made against stale text are dropped
    // (and the webview resynced) instead of landing in the wrong place.
    let seq = 0;
    let applying = false;
    let queue: Promise<unknown> = Promise.resolve();
    const sendText = (type: 'init' | 'update', extra: object = {}) => {
      seq++;
      post({ type, seq, text: document.getText().replace(/\r\n?/g, '\n'), ...extra });
    };

    const applyEdit = async (changes: LineChange[], editSeq: number) => {
      if (editSeq !== seq) { sendText('update'); return; }
      const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
      const edit = new vscode.WorkspaceEdit();
      for (const c of changes) { edit.replace(document.uri, new vscode.Range(c.fl, c.fc, c.tl, c.tc), eol === '\n' ? c.insert : c.insert.replace(/\n/g, eol)); }
      const before = document.version;
      applying = true;
      try { await vscode.workspace.applyEdit(edit); } finally { applying = false; }
      // Anything other than exactly our edit (another extension, a failed edit): resync.
      if (document.version !== before + 1) { sendText('update'); }
    };

    const settings = () => {
      const c = vscode.workspace.getConfiguration('diamond.liveEditor');
      return { toolbar: c.get('toolbar', true), readableLineLength: c.get('readableLineLength', true), fontSize: c.get<number>('fontSize') || undefined, fontFamily: c.get<string>('fontFamily') || undefined };
    };

    const disposables: vscode.Disposable[] = [
      panel.webview.onDidReceiveMessage(async msg => {
        switch (msg.type) {
          case 'ready': {
            session.ready = true;
            const reveal = this.pendingReveals.get(key);
            this.pendingReveals.delete(key);
            sendText('init', { settings: settings(), reveal });
            break;
          }
          case 'edit':
            queue = queue.then(() => applyEdit(msg.changes, msg.seq)).catch(err => console.error('[diamond] edit failed', err));
            break;
          case 'open':
            await openLink(this.index, { from: key, target: msg.target, heading: msg.heading, kind: msg.kind }, { beside: !!msg.beside, live: this });
            break;
          case 'selection':
            session.selection = msg.selection;
            this._onDidChangeActive.fire();
            break;
          case 'command':
            // Let pending keystrokes reach the document first (e.g. so switching to the source saves everything).
            if (TOOLBAR_COMMANDS.has(msg.id)) { await queue; await vscode.commands.executeCommand(msg.id); }
            break;
          case 'clipboardWrite':
            if (typeof msg.text === 'string') { await vscode.env.clipboard.writeText(msg.text); }
            break;
          case 'clipboardRead':
            post({ type: 'clipboardText', text: await vscode.env.clipboard.readText() });
            break;
          case 'probeResult':
            this.probeWaiter?.(msg.images);
            break;
          case 'openExternal':
            if (/^(https?|mailto):/i.test(msg.href)) { await vscode.env.openExternal(vscode.Uri.parse(msg.href)); }
            break;
          case 'resolve': {
            await this.index.ready;
            const items: Record<string, unknown> = {};
            for (const { key: k, target, kind } of msg.items as { key: string; target: string; kind: 'wiki' | 'markdown' }[]) {
              const uri = this.index.resolve({ target, kind }, document.uri);
              items[k] = uri
                ? { exists: true, path: this.index.relativePath(uri), src: IMAGE.test(uri.path) ? panel.webview.asWebviewUri(uri).toString() : undefined }
                : { exists: false };
            }
            post({ type: 'resolved', items });
            break;
          }
        }
      }),
      vscode.workspace.onDidChangeTextDocument(e => {
        // Our own edits are already in the webview; anything else (source editor, undo, Git…) is sent over.
        if (!applying && e.contentChanges.length && e.document === document) { sendText('update'); }
      }),
      // Link targets only resolve differently when files come or go.
      this.index.onDidChangeFiles(() => post({ type: 'invalidate' })),
      panel.onDidChangeViewState(() => this._onDidChangeActive.fire()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('diamond.liveEditor')) { sendText('init', { settings: settings() }); }
      }),
    ];

    panel.onDidDispose(() => {
      this.sessions.delete(session);
      this._onDidChangeActive.fire();
      disposables.forEach(d => d.dispose());
    });
  }

  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'liveEditor.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'liveEditor.css'));
    const n = nonce();
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style}" rel="stylesheet"><title>Live editor</title></head>
<body><div id="editor"></div><script nonce="${n}" src="${script}"></script></body></html>`;
  }
}
