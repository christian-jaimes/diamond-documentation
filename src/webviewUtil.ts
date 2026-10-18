import * as vscode from 'vscode';

/** Random token for a webview's Content-Security-Policy script nonce. */
export function nonce(): string {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

/** The file shown in the active editor tab (text editor or live editor), if any. */
export function activeTabUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom ? input.uri : undefined;
}
