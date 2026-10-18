// Word / character counts of Markdown as a reader sees it (syntax characters are not counted).

export interface TextStats { words: number; chars: number; }

/** Strip Markdown syntax, keeping the text a reader would see. */
export function readableText(md: string): string {
  let text = md.replace(/\r\n?/g, '\n');
  text = text.replace(/^---\n[\s\S]*?\n(---|\.\.\.)\s*(\n|$)/, '');            // front matter
  return text.split('\n').map(line => line
    .replace(/^\s*(```|~~~).*$/, '')                                           // code fences (keep the code itself)
    .replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/, '')          // table separator rows
    .replace(/^\s{0,3}(#{1,6})\s+/, '')                                        // headings
    .replace(/^\s*(>\s?)+/, '')                                                // quotes
    .replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '')                      // list markers and tasks
    .replace(/^\s*([-*_]\s*){3,}$/, '')                                        // horizontal rules
    .replace(/!\[\[[^\]]*\]\]/g, '')                                           // embeds
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')                                      // images
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')                            // [[target|alias]] → alias
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')                                   // [text](url) → text
    .replace(/<[^>\n]+>/g, '')                                                 // html tags
    .replace(/(\*\*|__|~~|==|\*|`)/g, '')                                      // emphasis markers
    .replace(/\s*\|\s*/g, ' ')                                                 // table pipes
    .trim()).join('\n');
}

export function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_.-]*/gu) ?? []).length;
}

export function textStats(md: string): TextStats {
  const text = readableText(md);
  return { words: countWords(text), chars: text.replace(/\n/g, '').length };
}
