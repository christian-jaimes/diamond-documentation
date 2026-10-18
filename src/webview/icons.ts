// The toolbar's VS Code icons (codicons), inlined as SVG text at build time:
// a few KB instead of the whole icon font.
import bold from '@vscode/codicons/src/icons/bold.svg';
import italic from '@vscode/codicons/src/icons/italic.svg';
import symbolColor from '@vscode/codicons/src/icons/symbol-color.svg';
import code from '@vscode/codicons/src/icons/code.svg';
import listUnordered from '@vscode/codicons/src/icons/list-unordered.svg';
import listOrdered from '@vscode/codicons/src/icons/list-ordered.svg';
import tasklist from '@vscode/codicons/src/icons/tasklist.svg';
import quote from '@vscode/codicons/src/icons/quote.svg';
import link from '@vscode/codicons/src/icons/link.svg';
import fileCode from '@vscode/codicons/src/icons/file-code.svg';
import table from '@vscode/codicons/src/icons/table.svg';
import horizontalRule from '@vscode/codicons/src/icons/horizontal-rule.svg';
import typeHierarchySub from '@vscode/codicons/src/icons/type-hierarchy-sub.svg';

export const ICONS: Record<string, string> = {
  bold, italic, 'symbol-color': symbolColor, code, 'list-unordered': listUnordered, 'list-ordered': listOrdered,
  tasklist, quote, link, 'file-code': fileCode, table, 'horizontal-rule': horizontalRule, 'type-hierarchy-sub': typeHierarchySub,
};
