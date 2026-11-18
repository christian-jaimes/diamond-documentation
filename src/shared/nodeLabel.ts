// Graph node labels (no vscode dependency, unit-tested in plain Node).

export type NodeLabelMode = 'title' | 'fileName';

export const DEFAULT_NODE_LABEL_MODE: NodeLabelMode = 'title';

export function parseNodeLabelMode(value: unknown): NodeLabelMode {
  return value === 'fileName' ? 'fileName' : DEFAULT_NODE_LABEL_MODE;
}

export interface LabelInput {
  /** Workspace-relative path with forward slashes, e.g. `guides/setup.md`. */
  path: string;
  isMarkdown: boolean;
  /** Text of the note's first level-1 heading, if it has one. */
  heading?: string;
}

const MD_EXT = /\.(md|markdown|mdx)$/i;

/** Plain name: the file name, without the extension for Markdown notes. */
export function fileNameLabel(path: string, isMarkdown: boolean): string {
  const name = path.split('/').pop() || path;
  return isMarkdown ? name.replace(MD_EXT, '') : name;
}

/** Parent directory + name, e.g. `guides/setup`; just the name for files at the root. */
export function parentNameLabel(path: string, isMarkdown: boolean): string {
  const parts = path.split('/').filter(Boolean);
  const name = fileNameLabel(path, isMarkdown);
  return parts.length > 1 ? `${parts[parts.length - 2]}/${name}` : name;
}

/** Strip the Markdown a heading may carry (emphasis, code, links) so the label reads as plain text. */
export function plainHeading(text: string): string {
  return text
    .replace(/!?\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|==|[*`])/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function nodeLabel(mode: NodeLabelMode, input: LabelInput): string {
  if (mode === 'fileName') { return fileNameLabel(input.path, input.isMarkdown); }
  if (input.isMarkdown && input.heading) {
    const h = plainHeading(input.heading);
    if (h) { return h; }
  }
  return parentNameLabel(input.path, input.isMarkdown);
}
