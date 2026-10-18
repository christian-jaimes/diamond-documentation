// Bundles the extension (Node) and the live editor (browser) with esbuild.
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = { bundle: true, minify: production, sourcemap: !production, legalComments: 'none', logLevel: 'info' };

const builds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'] },
  // Toolbar icons are imported as SVG text (see src/webview/icons.ts).
  { ...common, entryPoints: ['src/webview/liveEditor.ts'], outfile: 'dist/liveEditor.js', platform: 'browser', format: 'iife', target: 'es2020', loader: { '.svg': 'text' } },
  { ...common, entryPoints: ['media/graph.js'], outfile: 'dist/graph.js', platform: 'browser', format: 'iife', target: 'es2020' },
];

if (watch) {
  for (const b of builds) { await (await esbuild.context(b)).watch(); }
} else {
  await Promise.all(builds.map(b => esbuild.build(b)));
}
