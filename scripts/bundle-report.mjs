// Prints what each bundle is made of (minified bytes per package), largest first.
import * as esbuild from 'esbuild';

const targets = [
  { name: 'extension', entryPoints: ['src/extension.ts'], platform: 'node', format: 'cjs', external: ['vscode'] },
  { name: 'liveEditor', entryPoints: ['src/webview/liveEditor.ts'], platform: 'browser', format: 'iife', loader: { '.svg': 'text' } },
];

for (const { name, ...opts } of targets) {
  const result = await esbuild.build({ ...opts, bundle: true, minify: true, write: false, metafile: true, outdir: 'out-report' });
  const output = Object.values(result.metafile.outputs).find(o => o.entryPoint);
  const byPackage = {};
  for (const [file, info] of Object.entries(output.inputs)) {
    const pkg = /node_modules[\\/]((@[^\\/]+[\\/])?[^\\/]+)/.exec(file)?.[1] ?? 'src';
    byPackage[pkg] = (byPackage[pkg] ?? 0) + info.bytesInOutput;
  }
  console.log(`\n${name}: ${(output.bytes / 1024).toFixed(0)} KB`);
  for (const [pkg, bytes] of Object.entries(byPackage).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${(bytes / 1024).toFixed(1).padStart(7)} KB  ${pkg}`);
  }
}
