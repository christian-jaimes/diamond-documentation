// Plain-Node smoke tests: parser + preview plugin (vscode module mocked).
const assert = require('assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const { parseNote, splitWikiTarget, slugify } = require('../out/parser');

const n = parseNote([
  '---', 'title: [[not a link]]', '---',
  '# Title', 'See [[Setup Guide#Install|install]] and ![[diagram.png]].',
  'Code `[[ignored]]` and [rel](../api/README.md#auth) and [web](https://x.y).',
  '```', '[[in fence]]', '```', '- [ ] task #todo',
].join('\n'));
assert.deepStrictEqual(n.links.map(l => [l.kind, l.target, l.heading, l.alias, l.embed]), [
  ['wiki', 'Setup Guide', 'Install', 'install', false],
  ['wiki', 'diagram.png', undefined, undefined, true],
  ['markdown', '../api/README.md', 'auth', 'rel', false],
]);
const l0 = n.links[0];
assert.strictEqual('See [[Setup Guide#Install|install]]'.slice(l0.targetStart, l0.targetEnd), 'Setup Guide');
assert.deepStrictEqual(n.headings.map(h => h.text), ['Title']);
assert.deepStrictEqual(n.tags, ['todo']);
assert.deepStrictEqual(splitWikiTarget('a/b#c|d'), { target: 'a/b', heading: 'c', alias: 'd', aliasOffset: 6 });
assert.strictEqual(slugify('Install & Run!'), 'install--run');

// Preview plugin with a fake vscode + index
const fakeUri = p => ({ path: p, fsPath: p, scheme: 'file', toString: () => 'file://' + p });
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? {} : origLoad.call(this, req, ...rest); };
const { diamondMarkdownIt } = require('../out/preview');
const index = {
  resolve: (link) => ({ 'Setup Guide': fakeUri('/v/docs/Setup Guide.md'), 'logo.png': fakeUri('/v/img/logo.png') })[link.target],
  relativePath: u => u.path.slice(3),
};
const md = diamondMarkdownIt(require('markdown-it')(), index);
const html = md.render('[[Setup Guide#Install|install]] ==hot== [[Missing]] ![[logo.png|120]]\n\n- [x] done\n- [ ] todo', { currentDocument: fakeUri('/v/notes/a.md') });
assert.match(html, /href="..\/docs\/Setup%20Guide.md#install"[^>]*>install<\/a>/);
assert.match(html, /<mark>hot<\/mark>/);
assert.match(html, /diamond-unresolved" href="Missing.md"/);
assert.match(html, /<img class="diamond-embed-img" src="..\/img\/logo.png" alt="logo.png" width="120">/);
assert.match(html, /class="diamond-task-item done"><input type="checkbox" class="diamond-task" disabled checked> done/);


// Shared formatting logic (used by both editors)
const fmt = require('../out/shared/format');
const apply = (text, r) => [...r.changes].sort((a, b) => b.from - a.from).reduce((t, c) => t.slice(0, c.from) + c.insert + t.slice(c.to), text);
let r = fmt.toggleWrap('hello world', [{ anchor: 0, head: 5 }], '**');
assert.strictEqual(apply('hello world', r), '**hello** world');
assert.deepStrictEqual(r.selections, [{ anchor: 2, head: 7 }]);
r = fmt.toggleWrap('**hello** world', r.selections, '**');
assert.strictEqual(apply('**hello** world', r), 'hello world');
r = fmt.toggleWrap('a b', [{ anchor: 0, head: 0 }, { anchor: 2, head: 2 }], '==');
assert.strictEqual(apply('a b', r), '==a== ==b==');
r = fmt.transformLines('one\ntwo', [{ anchor: 1, head: 6 }], fmt.LINE_OPS.checkbox);
assert.strictEqual(apply('one\ntwo', r), '- [ ] one\n- [ ] two');
r = fmt.transformLines('- [ ] one', [{ anchor: 9, head: 9 }], fmt.LINE_OPS.checkbox);
assert.strictEqual(apply('- [ ] one', r), '- [x] one');
assert.strictEqual(r.selections[0].head, 9);
r = fmt.transformLines('a\nb', [{ anchor: 0, head: 3 }], fmt.LINE_OPS.numbered);
assert.strictEqual(apply('a\nb', r), '1. a\n2. b');
r = fmt.codeBlock('x', [{ anchor: 0, head: 1 }], 'sql');
assert.strictEqual(apply('x', r), '```sql\nx\n```');
r = fmt.formatTable('|a|bb|\n|-|-|\n|ccc|d|', 0);
assert.strictEqual(apply('|a|bb|\n|-|-|\n|ccc|d|', r), '| a   | bb  |\n| --- | --- |\n| ccc | d   |');

// Graph colour config
const colors = require('../out/shared/colors');
const cfg = colors.parseColorConfig(fs.readFileSync(path.join(__dirname, '../sample-docs/.diamond/graph.yml'), 'utf8'));
assert.deepStrictEqual(cfg.errors, []);
assert.strictEqual(colors.colorFor(cfg, 'docs/Getting Started.md', 'note'), '#4f9dff');
assert.strictEqual(colors.colorFor(cfg, 'docs/architecture/Storage.md', 'note'), '#a371f7'); // deepest folder wins
assert.strictEqual(colors.colorFor(cfg, 'database/schema.sql', 'file'), '#3fb950');
assert.strictEqual(colors.colorFor(cfg, 'docs/logo.svg', 'file'), '#db61a2');            // pattern beats folder
assert.strictEqual(colors.colorFor(cfg, 'README.md', 'note'), '#9da5b4');                 // default
assert.strictEqual(colors.colorFor(cfg, 'x', 'ghost'), '#6e7681');
assert.strictEqual(colors.parseColorConfig('{"folders": {"src": "red"}}').rules[0].color, 'red'); // JSON works too
assert.ok(colors.parseColorConfig('folders: [').errors.length > 0);
const { globToRegExp } = require('../out/shared/glob');
assert.ok(globToRegExp('**/*.sql').test('a/b/c.sql') && globToRegExp('**/*.sql').test('c.sql'));

// Word / character counts ignore Markdown syntax
const stats = require('../out/shared/stats');
assert.deepStrictEqual(stats.textStats('# Hello **world**'), { words: 2, chars: 11 });
assert.strictEqual(stats.textStats('- [ ] Buy [[Milk Store|milk]] and [eggs](x.md)').words, 4);
assert.strictEqual(stats.textStats('---\ntitle: x\n---\nOne two').words, 2);
assert.strictEqual(stats.textStats('| a | b |\n| --- | --- |\n| c | d |').words, 4);
assert.strictEqual(stats.textStats("it's v1.2 ok").words, 3);
assert.strictEqual(fmt.setHeadingLine('## Title', 0), 'Title');
assert.strictEqual(fmt.setHeadingLine('Title', 3), '### Title');

// Small YAML reader used for .diamond/graph.yml
const { parseYaml } = require('../out/shared/miniYaml');
assert.deepStrictEqual(parseYaml('folders:\n  docs: "#4f9dff"  # blue\n  "docs/a b": { color: "#fff", label: "A, B" }\npatterns:\n  # none\ndefaults:\n  files: \'#d29922\''),
  { folders: { docs: '#4f9dff', 'docs/a b': { color: '#fff', label: 'A, B' } }, patterns: {}, defaults: { files: '#d29922' } });
assert.throws(() => parseYaml('folders:\n\tdocs: x'), /tabs/);
assert.throws(() => parseYaml('just text'), /key: value/);
assert.deepStrictEqual(parseYaml('{"folders":{"x":"red"}}'), { folders: { x: 'red' } });
assert.match(colors.parseColorConfig('folders:\n  docs: #4f9dff').errors[0], /in quotes/); // unquoted # starts a comment

// Notes only signal a change when links or tags change, not plain text
const { noteSignature, parseNote: parse } = require('../out/parser');
assert.strictEqual(noteSignature(parse('a [[x]] #t')), noteSignature(parse('b c [[x]] d #t')));
assert.notStrictEqual(noteSignature(parse('[[x]]')), noteSignature(parse('[[y]]')));

console.log('all tests passed');
