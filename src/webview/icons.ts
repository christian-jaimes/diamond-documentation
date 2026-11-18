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
import arrow_up from '@vscode/codicons/src/icons/arrow-up.svg';
import arrow_down from '@vscode/codicons/src/icons/arrow-down.svg';
import case_sensitive from '@vscode/codicons/src/icons/case-sensitive.svg';
import whole_word from '@vscode/codicons/src/icons/whole-word.svg';
import regex from '@vscode/codicons/src/icons/regex.svg';
import chevron_right from '@vscode/codicons/src/icons/chevron-right.svg';
import chevron_down from '@vscode/codicons/src/icons/chevron-down.svg';
import close from '@vscode/codicons/src/icons/close.svg';
import list_selection from '@vscode/codicons/src/icons/list-selection.svg';
import replace from '@vscode/codicons/src/icons/replace.svg';
import replace_all from '@vscode/codicons/src/icons/replace-all.svg';

export const ICONS: Record<string, string> = {
  bold, italic, 'symbol-color': symbolColor, code, 'list-unordered': listUnordered, 'list-ordered': listOrdered,
  tasklist, quote, link, 'file-code': fileCode, table, 'horizontal-rule': horizontalRule, 'type-hierarchy-sub': typeHierarchySub,
  'arrow-up': arrow_up, 'arrow-down': arrow_down, 'case-sensitive': case_sensitive, 'whole-word': whole_word, 'regex': regex, 'chevron-right': chevron_right, 'chevron-down': chevron_down, 'close': close, 'list-selection': list_selection, 'replace': replace, 'replace-all': replace_all,
};
