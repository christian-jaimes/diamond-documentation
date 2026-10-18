// Graph colour rules from `.diamond/graph.yml` (or .yaml / .json). Pure logic, no vscode dependency.
import { globToRegExp } from './glob';
import { parseYaml } from './miniYaml';

export type NodeKind = 'note' | 'file' | 'ghost';

export interface ColorRule { label: string; color: string; depth: number; test: (relPath: string) => boolean; }

export interface ColorConfig {
  rules: ColorRule[];
  defaults: { documentation?: string; files?: string; unresolved?: string };
  errors: string[];
}

const cleanFolder = (f: string) => f.replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '').toLowerCase();
const asObject = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {});

export function parseColorConfig(text: string): ColorConfig {
  const errors: string[] = [];
  let raw: Record<string, any>;
  try { raw = asObject(parseYaml(text)); } catch (e) { return { rules: [], defaults: {}, errors: [(e as Error).message] }; }

  const asColor = (v: unknown, where: string): string | undefined => {
    const c = typeof v === 'string' ? v : asObject(v).color;
    if (typeof c === 'string' && c.trim()) { return c.trim(); }
    errors.push(`${where}: expected a colour in quotes, such as "#4f9dff".`);
    return undefined;
  };

  for (const section of ['folders', 'patterns', 'defaults']) {
    if (raw[section] != null && (typeof raw[section] !== 'object' || Array.isArray(raw[section]))) { errors.push(`${section}: expected indented "key: value" lines.`); }
  }
  const rules: ColorRule[] = [];
  for (const [folder, value] of Object.entries(asObject(raw.folders))) {
    const color = asColor(value, `folders.${folder}`);
    if (!color) { continue; }
    const f = cleanFolder(folder);
    rules.push({
      label: asObject(value).label ?? (f || '(root)'), color, depth: f ? f.split('/').length : 0,
      test: p => { const l = p.toLowerCase(); return !f || l === f || l.startsWith(f + '/'); },
    });
  }
  for (const [pattern, value] of Object.entries(asObject(raw.patterns))) {
    const color = asColor(value, `patterns.${pattern}`);
    if (!color) { continue; }
    const re = globToRegExp(pattern);
    rules.push({ label: asObject(value).label ?? pattern, color, depth: 1000, test: p => re.test(p) });
  }
  const d = asObject(raw.defaults);
  const defaults: ColorConfig['defaults'] = {};
  for (const k of ['documentation', 'files', 'unresolved'] as const) { if (d[k] != null) { defaults[k] = asColor(d[k], `defaults.${k}`); } }
  return { rules, defaults, errors };
}

/** Colour for a node: file patterns win, then the deepest matching folder, then the defaults. */
export function colorFor(cfg: ColorConfig, relPath: string, kind: NodeKind): string | undefined {
  if (kind === 'ghost') { return cfg.defaults.unresolved; }
  let best: ColorRule | undefined;
  for (const r of cfg.rules) {
    if ((!best || r.depth >= best.depth) && r.test(relPath)) { best = r; }
  }
  return best?.color ?? (kind === 'note' ? cfg.defaults.documentation : cfg.defaults.files);
}

export function templateYaml(folders: string[]): string {
  const palette = ['#4f9dff', '#a371f7', '#3fb950', '#f0883e', '#db61a2', '#e3b341', '#39c5cf', '#f85149'];
  return [
    '# Diamond Documentation – graph colours',
    '#',
    '# folders:  every note and file inside the folder (sub-folders included) gets the colour.',
    '#           When folders are nested, the deepest one wins.',
    '# patterns: glob patterns that win over folders, e.g. "**/*.sql".',
    '# defaults: colours for anything not matched above.',
    '# Put colours in quotes: "#4f9dff".',
    '',
    'folders:',
    ...(folders.length ? folders.map((f, i) => `  ${JSON.stringify(f)}: "${palette[i % palette.length]}"`) : ['  docs: "#4f9dff"']),
    '',
    'patterns:',
    '  # "**/*.sql": "#3fb950"',
    '',
    'defaults:',
    '  documentation: "#9da5b4"',
    '  files: "#d29922"',
    '  unresolved: "#6e7681"',
    '',
  ].join('\n');
}
