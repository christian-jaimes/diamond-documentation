// A small YAML reader for configuration files: nested mappings, quoted or plain
// scalars, `{ a: b }` flow mappings and comments. (JSON input is parsed as JSON.)
// It replaces a full YAML library, which was most of the extension's size.

export class YamlError extends Error {}

/** Remove a `# comment` that is outside quotes and starts the line or follows whitespace. */
function stripComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) { quote = ''; } continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) { return line.slice(0, i); }
  }
  return line;
}

function unquote(s: string): string {
  s = s.trim();
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    const body = s.slice(1, -1);
    return s[0] === '"' ? body.replace(/\\(["\\])/g, '$1') : body.replace(/''/g, "'");
  }
  return s;
}

/** Split on `sep` outside quotes. */
function splitOutsideQuotes(s: string, sep: string): string[] {
  const parts: string[] = [];
  let quote = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) { quote = ''; } continue; }
    if (c === '"' || c === "'") { quote = c; }
    else if (c === sep) { parts.push(s.slice(start, i)); start = i + 1; }
  }
  parts.push(s.slice(start));
  return parts;
}

/** Position of the `key: value` colon (outside quotes, followed by a space or the end of the line). */
function keyColon(s: string): number {
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) { quote = ''; } continue; }
    if (c === '"' || c === "'") { quote = c; }
    else if (c === ':' && (i === s.length - 1 || s[i + 1] === ' ')) { return i; }
  }
  return -1;
}

function scalar(raw: string, lineNo: number): unknown {
  const s = raw.trim();
  if (s.startsWith('{')) {
    if (!s.endsWith('}')) { throw new YamlError(`Line ${lineNo}: unclosed "{".`); }
    const obj: Record<string, unknown> = {};
    for (const pair of splitOutsideQuotes(s.slice(1, -1), ',')) {
      if (!pair.trim()) { continue; }
      const colon = keyColon(pair);
      if (colon < 0) { throw new YamlError(`Line ${lineNo}: expected "key: value" inside "{ }".`); }
      obj[unquote(pair.slice(0, colon))] = scalar(pair.slice(colon + 1), lineNo);
    }
    return obj;
  }
  if (s.startsWith('[') || s.startsWith('- ')) { throw new YamlError(`Line ${lineNo}: lists are not supported; use "key: value" pairs.`); }
  if (s[0] === '"' || s[0] === "'") { return unquote(s); }
  if (s === 'true' || s === 'false') { return s === 'true'; }
  if (s === '' || s === 'null' || s === '~') { return null; }
  if (/^-?\d+(\.\d+)?$/.test(s)) { return Number(s); }
  return s;
}

export function parseYaml(text: string): unknown {
  if (/^\s*[{[]/.test(text)) {
    try { return JSON.parse(text); } catch (e) { throw new YamlError(String((e as Error).message)); }
  }
  const root: Record<string, unknown> = {};
  const stack: { indent: number; obj: Record<string, unknown> }[] = [{ indent: -1, obj: root }];
  text.split(/\r?\n/).forEach((rawLine, i) => {
    const line = stripComment(rawLine).replace(/\s+$/, '');
    if (!line.trim() || line.trim() === '---') { return; }
    const indentText = /^\s*/.exec(line)![0];
    if (indentText.includes('\t')) { throw new YamlError(`Line ${i + 1}: use spaces, not tabs, for indentation.`); }
    const body = line.slice(indentText.length);
    const colon = keyColon(body);
    if (colon <= 0) { throw new YamlError(`Line ${i + 1}: expected "key: value".`); }
    while (stack[stack.length - 1].indent >= indentText.length) { stack.pop(); }
    const parent = stack[stack.length - 1].obj;
    const key = unquote(body.slice(0, colon));
    const rest = body.slice(colon + 1).trim();
    if (rest) {
      parent[key] = scalar(rest, i + 1);
    } else {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent: indentText.length, obj: child });
    }
  });
  return root;
}
