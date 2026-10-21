import * as vscode from 'vscode';
import { isMarkdown } from './linkIndex';
import { LiveEditorProvider } from './liveEditor';

export const liveIsDefault = () => vscode.workspace.getConfiguration('diamond.liveEditor').get<boolean>('openByDefault', true);

/**
 * Opens Markdown files in the live editor by default.
 *
 * Instead of registering the live editor as VS Code's default editor (which
 * would also take over Git diffs), every plain text tab that opens for a
 * Markdown file is swapped for a live editor tab. Diffs, untitled files,
 * files with unsaved changes and files explicitly opened as source are left alone.
 */
export function registerOpenByDefault(ctx: vscode.ExtensionContext, live: LiveEditorProvider) {
  /** Files the user asked to see as source; they stay in the text editor until that tab closes. */
  const sourceWanted = new Set<string>();
  const busy = new Set<string>();

  const redirect = async (tab: vscode.Tab) => {
    const input = tab.input;
    if (!(input instanceof vscode.TabInputText) || input.uri.scheme !== 'file' || !isMarkdown(input.uri)) { return; }
    const key = input.uri.toString();
    if (!liveIsDefault() || sourceWanted.has(key) || busy.has(key)) { return; }
    const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
    if (doc?.isDirty) { return; }
    busy.add(key);
    try {
      // Let VS Code finish placing the cursor (e.g. "Go to Definition", search results) and carry it over.
      await new Promise(r => setTimeout(r, 60));
      const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === key && e.viewColumn === tab.group.viewColumn);
      const line = editor?.selection.active.line ?? 0;
      if (line > 0) { live.revealWhenOpen(input.uri, line); }
      await vscode.commands.executeCommand('vscode.openWith', input.uri, LiveEditorProvider.viewType, {
        viewColumn: tab.group.viewColumn, preview: tab.isPreview, preserveFocus: !tab.isActive,
      });
      const stale = tab.group.tabs.find(t => t.input instanceof vscode.TabInputText && t.input.uri.toString() === key);
      if (stale) { await vscode.window.tabGroups.close(stale, true); }
    } finally {
      busy.delete(key);
    }
  };

  setTimeout(redirectActiveTabOnStartup, 0);
  ctx.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(e => {
      for (const tab of e.opened) { void redirect(tab); }
      for (const tab of e.closed) {
        if (tab.input instanceof vscode.TabInputText) {
          const key = tab.input.uri.toString();
          const stillOpen = vscode.window.tabGroups.all.some(g => g.tabs.some(t => t.input instanceof vscode.TabInputText && t.input.uri.toString() === key));
          if (!stillOpen) { sourceWanted.delete(key); }
        }
      }
    }),
    vscode.commands.registerCommand('diamond._redirectTab', (tab: vscode.Tab) => redirect(tab)),
    // Switch between the live editor and the source in place (same tab position).
    // Unsaved changes are saved first, so closing the old view never asks "Save changes?".
    vscode.commands.registerCommand('diamond.openSourceEditor', async (uri?: vscode.Uri) => {
      const target = uri ?? live.active()?.document.uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) { return; }
      await saveIfDirty(target);
      sourceWanted.add(target.toString());
      const old = findTab(target, t => t.input instanceof vscode.TabInputCustom);
      await vscode.commands.executeCommand('vscode.openWith', target, 'default', old?.group.viewColumn);
      if (old) { await vscode.window.tabGroups.close(old, true); }
    }),
    vscode.commands.registerCommand('diamond.openLiveEditor', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) { return; }
      await saveIfDirty(target);
      sourceWanted.delete(target.toString());
      const old = findTab(target, t => t.input instanceof vscode.TabInputText);
      await vscode.commands.executeCommand('vscode.openWith', target, LiveEditorProvider.viewType, old?.group.viewColumn);
      if (old && !vscode.workspace.textDocuments.find(d => d.uri.toString() === target.toString())?.isDirty) {
        await vscode.window.tabGroups.close(old, true);
      }
    }),
  );
}

/** The first Markdown file can open before the extension activates: switch it too. */
export function redirectActiveTabOnStartup() {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (tab) { void vscode.commands.executeCommand('diamond._redirectTab', tab); }
}

async function saveIfDirty(uri: vscode.Uri) {
  const key = uri.toString();
  const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
  if (doc?.isDirty) { await doc.save(); }
}

function findTab(uri: vscode.Uri, kind: (t: vscode.Tab) => boolean): vscode.Tab | undefined {
  const key = uri.toString();
  const inGroup = (g: vscode.TabGroup) => g.tabs.find(t => kind(t) && (t.input as { uri?: vscode.Uri }).uri?.toString() === key);
  return inGroup(vscode.window.tabGroups.activeTabGroup) ?? vscode.window.tabGroups.all.map(inGroup).find(Boolean);
}
