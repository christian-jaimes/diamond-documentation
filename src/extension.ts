import * as vscode from 'vscode';
import type MarkdownIt from 'markdown-it';
import { LinkIndex } from './linkIndex';
import { registerFormatting } from './formatting';
import { registerLinkFeatures, setLiveTarget } from './linkFeatures';
import { registerLinkViews } from './linkViews';
import { registerRenameHandling } from './renameLinks';
import { GraphPanel, GraphSidebarProvider } from './graphView';
import { GraphColors } from './colorConfig';
import { LiveEditorProvider } from './liveEditor';
import { diamondMarkdownIt } from './preview';
import { registerOpenByDefault } from './openDefault';
import { registerStatusBar } from './statusBar';


export function activate(ctx: vscode.ExtensionContext) {
  const index = new LinkIndex();
  index.start();
  const colors = new GraphColors();
  void colors.start();
  ctx.subscriptions.push(index, colors);

  const live = LiveEditorProvider.register(ctx, index);
  setLiveTarget(live);
  registerOpenByDefault(ctx, live);
  registerStatusBar(ctx, index, live);
  registerFormatting(ctx, live, index);
  registerLinkFeatures(ctx, index);
  registerLinkViews(ctx, index);
  registerRenameHandling(ctx, index);

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(GraphSidebarProvider.viewId, new GraphSidebarProvider(ctx, index, colors), { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('diamond.openGraph', () => GraphPanel.show(ctx, index, colors, false)),
    vscode.commands.registerCommand('diamond.openLocalGraph', () => GraphPanel.show(ctx, index, colors, true)),
    vscode.commands.registerCommand('diamond.configureGraphColors', () => colors.configure()),
    vscode.commands.registerCommand('diamond.reindex', async () => {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Indexing links…' }, () => index.rebuild());
    }),
  );

  // Returned to VS Code's markdown preview (enabled by "markdown.markdownItPlugins" in package.json).
  return { extendMarkdownIt: (md: MarkdownIt) => diamondMarkdownIt(md, index) };
}

export function deactivate() { /* disposables handle cleanup */ }
