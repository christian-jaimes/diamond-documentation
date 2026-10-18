// Lezer markdown extensions for syntax the base GFM grammar does not know:
//   ==highlight==   [[wikilinks]]   ![[embeds]]   #tags
import type { MarkdownConfig } from '@lezer/markdown';
import { tags as t } from '@lezer/highlight';

const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' };
const isSpace = (s: string) => s === '' || /\s/.test(s);

export const Highlight: MarkdownConfig = {
  defineNodes: [{ name: 'Highlight', style: t.special(t.emphasis) }, { name: 'HighlightMark', style: t.processingInstruction }],
  parseInline: [{
    name: 'Highlight',
    parse(cx, next, pos) {
      if (next !== 61 /* = */ || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) { return -1; }
      const before = cx.slice(pos - 1, pos), after = cx.slice(pos + 2, pos + 3);
      return cx.addDelimiter(HighlightDelim, pos, pos + 2, !isSpace(after), !isSpace(before));
    },
    after: 'Emphasis',
  }],
};

export const WikiLink: MarkdownConfig = {
  defineNodes: [
    { name: 'WikiLink', style: t.link },
    { name: 'WikiEmbed', style: t.link },
    { name: 'WikiLinkMark', style: t.processingInstruction },
  ],
  parseInline: [{
    name: 'WikiLink',
    parse(cx, next, pos) {
      const start = pos;
      if (next === 33 /* ! */) {
        if (cx.char(pos + 1) !== 91 || cx.char(pos + 2) !== 91) { return -1; }
        pos++;
      } else if (next !== 91 || cx.char(pos + 1) !== 91) {
        return -1;
      }
      const rest = cx.slice(pos + 2, cx.end);
      const close = rest.indexOf(']]');
      if (close <= 0 || /[\[\]\n]/.test(rest.slice(0, close))) { return -1; }
      const end = pos + 2 + close + 2;
      return cx.addElement(cx.elt(start !== pos ? 'WikiEmbed' : 'WikiLink', start, end, [
        cx.elt('WikiLinkMark', start, pos + 2),
        cx.elt('WikiLinkMark', end - 2, end),
      ]));
    },
    before: 'Link',
  }],
};

export const Tag: MarkdownConfig = {
  defineNodes: [{ name: 'Tag', style: t.labelName }],
  parseInline: [{
    name: 'Tag',
    parse(cx, next, pos) {
      if (next !== 35 /* # */ || (pos > cx.offset && !isSpace(cx.slice(pos - 1, pos)))) { return -1; }
      const m = /^#[\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*/u.exec(cx.slice(pos, cx.end));
      return m ? cx.addElement(cx.elt('Tag', pos, pos + m[0].length)) : -1;
    },
  }],
};
