import * as vscode from 'vscode';

/** Which of the document's diagnostics the live editor underlines. */
export type DiagnosticsMode = 'spelling' | 'all' | 'off';

/** A diagnostic as line/column positions (same convention as the edit protocol). */
export interface DiagItem { sl: number; sc: number; el: number; ec: number; message: string; severity: number; source?: string; }

const SPELLING = /spell/i; // "cSpell" (Code Spell Checker), "Spell Checker", …

export function diagnosticsMode(): DiagnosticsMode {
  const v = vscode.workspace.getConfiguration('diamond.liveEditor').get<string>('diagnostics', 'spelling');
  return v === 'all' || v === 'off' ? v : 'spelling';
}

/** The diagnostics other extensions (e.g. Code Spell Checker) report for `uri`, filtered by the setting. */
export function collectDiagnostics(uri: vscode.Uri, mode: DiagnosticsMode): DiagItem[] {
  if (mode === 'off') { return []; }
  const out: DiagItem[] = [];
  for (const d of vscode.languages.getDiagnostics(uri)) {
    if (mode === 'spelling' && !SPELLING.test(d.source ?? '')) { continue; }
    if (d.range.isEmpty) { continue; }
    out.push({ sl: d.range.start.line, sc: d.range.start.character, el: d.range.end.line, ec: d.range.end.character, message: d.message, severity: d.severity, source: d.source });
  }
  return out;
}

type Action = vscode.CodeAction | vscode.Command;

/** Quick fixes offered to the webview; remembers the last batch so a click can run the chosen one. */
export class QuickFixes {
  private batches = new Map<number, Action[]>();

  async list(uri: vscode.Uri, range: vscode.Range, id: number): Promise<{ title: string; preferred: boolean }[]> {
    let actions: Action[] = [];
    try {
      actions = (await vscode.commands.executeCommand<Action[]>('vscode.executeCodeActionProvider', uri, range, vscode.CodeActionKind.QuickFix.value, 12)) ?? [];
    } catch { /* no provider */ }
    actions = actions.filter(a => !('disabled' in a && a.disabled));
    this.batches.set(id, actions);
    for (const k of [...this.batches.keys()]) { if (k < id - 8) { this.batches.delete(k); } }
    return actions.map(a => ({ title: a.title, preferred: 'isPreferred' in a && !!a.isPreferred }));
  }

  async run(id: number, index: number) {
    const a = this.batches.get(id)?.[index];
    if (!a) { return; }
    const isAction = (x: Action): x is vscode.CodeAction => 'edit' in x || 'kind' in x || typeof (x as vscode.Command).command !== 'string';
    if (isAction(a)) {
      if (a.edit) { await vscode.workspace.applyEdit(a.edit); }
      if (a.command) { await vscode.commands.executeCommand(a.command.command, ...(a.command.arguments ?? [])); }
    } else {
      await vscode.commands.executeCommand(a.command, ...(a.arguments ?? []));
    }
  }
}
