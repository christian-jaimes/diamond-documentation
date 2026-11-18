// Tests for src/shared/mdTools.ts (run from test/run.js).
const assert = require('assert');
const f = require('../out/shared/mdTools');
const ap = (text, r) => [...r.changes].sort((a, b) => b.from - a.from).reduce((t, c) => t.slice(0, c.from) + c.insert + t.slice(c.to), text);

let x = f.pasteLink('see docs here', [{ anchor: 4, head: 8 }], 'https://x.io/a');
assert.strictEqual(ap('see docs here', x), 'see [docs](https://x.io/a) here');
assert.strictEqual(f.pasteLink('abc', [{ anchor: 1, head: 1 }], 'https://x.io'), undefined);
assert.strictEqual(f.pasteLink('abc', [{ anchor: 0, head: 3 }], 'not a url'), undefined);
assert.strictEqual(f.pasteLink('https://a.b', [{ anchor: 0, head: 11 }], 'https://x.io'), undefined);

const doc = '# Title\n\n## Intro\n\n```\n# not a heading\n```\n\n### Deep\n\n## Intro\n';
assert.strictEqual(f.tocList(doc), '- [Intro](#intro)\n  - [Deep](#deep)\n- [Intro](#intro-1)');
const withToc = ap(doc, f.updateToc(doc, 9));
assert.ok(withToc.includes('<!-- toc -->\n\n- [Intro](#intro)') && withToc.includes('<!-- /toc -->'));
assert.strictEqual(f.updateToc(withToc, 0), undefined);
const more = withToc + '## New\n';
assert.ok(ap(more, f.updateToc(more, 0)).includes('- [New](#new)'));

const tbl = '| a | b |\n| --- | --- |\n| 1 | 2 |';
x = f.tableNavigate(tbl, 2, true);
assert.strictEqual(ap(tbl, x).slice(x.selections[0].anchor, x.selections[0].head), 'b');
x = f.tableNavigate(tbl, 31, true);
assert.strictEqual(ap(tbl, x).split('\n').length, 4);
x = f.tableNavigate(tbl, 2, false);
assert.strictEqual(x.selections[0].anchor, 2);
assert.strictEqual(f.tableNavigate('plain', 0, true), undefined);

const lst = '1. a\n3. b\n   - x\n   1. p\n   5. q\n7. c\n\ntext\n\n4. z\n6. y';
assert.strictEqual(ap(lst, f.renumberLists(lst)), '1. a\n2. b\n   - x\n   1. p\n   2. q\n3. c\n\ntext\n\n4. z\n5. y');
assert.strictEqual(f.renumberLists('1. a\n2. b'), undefined);
