# Diamond Documentation: Developer Onboarding

Welcome! This guide covers what the extension does, how the code is organised, how to build, test and release it, and the non-obvious things we learned the hard way. For the user-facing feature list, see [README.md](README.md). For release history, see [CHANGELOG.md](CHANGELOG.md).

## At a glance

| | |
| --- | --- |
| What | A VS Code extension for writing project documentation as plain Markdown next to the code. It provides an editable live editor, `[[wikilinks]]` to any file type, link updates on rename, a graph view, backlinks and status-bar counts. |
| Extension ID | `christian-jaimes.diamond-documentation` (publisher `christian-jaimes`) |
| Version | 0.4.4 (see `package.json` and `CHANGELOG.md`) |
| Repository | https://github.com/christian-jaimes/diamond-documentation (branch `main`) |
| License | MIT |
| Language | TypeScript, bundled with esbuild. There are no runtime npm dependencies; everything is bundled into `dist/`. |
| VS Code API | Custom text editor, webview views/panels, document link/completion/hover/definition providers, rename events, tab groups API, tree views and the status bar |

## Getting started

```bash
git clone https://github.com/christian-jaimes/diamond-documentation.git
cd diamond-documentation
npm install
npm run compile
```

Then open the folder in VS Code and press **F5** (Run Extension). In the Extension Development Host, open a folder containing Markdown files. The repo's `sample-docs/` folder works well because it exercises links, images, tables and folder colours.

## npm scripts

| Script | What it does |
| --- | --- |
| `npm run compile` | Type-checks (`tsc --noEmit`), then bundles with `node build.mjs` |
| `npm test` | Compiles, bundles, and runs the unit tests in `test/run.js` |
| `npm run package` | Builds `diamond-documentation-<version>.vsix` (`vsce package --no-dependencies`) |
| `npm run publish` | Publishes to the Marketplace (`vsce publish --no-dependencies`); you must be logged in first, see below |
| `npm run bundle-report` | Prints what takes up space in each bundle |
| `npm run build-icon` | Regenerates `media/icon.png` from the SVG logo (uses `sharp`) |

`vscode:prepublish` runs a production build automatically before packaging or publishing.

## Build output

`build.mjs` (esbuild) produces three bundles:

| Bundle | Format | Source | Approx. size |
| --- | --- | --- | --- |
| `dist/extension.js` | CommonJS (extension host) | `src/extension.ts` | ~51 KB |
| `dist/liveEditor.js` | IIFE (webview) | `src/webview/liveEditor.ts` | ~360 KB |
| `dist/graph.js` | IIFE (webview) | `media/graph.js` | ~10 KB |

Size notes:
- The live editor builds its Markdown language from `markdownLanguage.data` plus `markdownLanguage.parser.configure([...])`, so `@codemirror/lang-markdown` does **not** pull in the HTML/CSS/JS parsers. Keep it that way.
- Codicon SVGs are imported as text (esbuild `.svg` text loader) from `@vscode/codicons`.
- `.diamond/graph.yml` is parsed by a small built-in YAML parser (`src/shared/miniYaml.ts`) instead of a YAML library.

## Code map

### Extension host (`src/`)

| File | Responsibility |
| --- | --- |
| `extension.ts` | Activation: creates the `LinkIndex`, colour config, live editor provider, and registers every feature below |
| `parser.ts` | Parses links, headings, tags and block IDs from Markdown (`IMAGE` regex lives here too) |
| `linkIndex.ts` | Workspace file index, link resolution, backlinks, graph data. Parses on typing (debounced 250 ms), only re-indexes when a note's link signature changes, and caches reverse links and graph data. `syncOpenDocuments()` flushes pending parses. |
| `linkFeatures.ts` | Clickable links (`command:` URIs), `[[` completion, hover previews, go-to-definition, create-note-on-click |
| `renameLinks.ts` | Rewrites links when files or folders are renamed or moved, then saves the changed files. Calls `index.syncOpenDocuments()` first so unsaved edits are not missed. |
| `liveEditor.ts` | The `diamond.liveEditor` custom text editor (extension side): sync protocol, clipboard bridge, image resolution, toolbar command allow-list |
| `openDefault.ts` | Redirects `.md` text tabs to the live editor, and switches between live and source in place (Ctrl+Shift+V). Saves a dirty file before switching. |
| `formatting.ts` + `shared/format.ts` | Formatting commands. The same operations run in the source editor and inside the live editor. |
| `graphView.ts` | `GraphController`, shared by the full graph panel and the sidebar view. The sidebar is a local graph of the active file and only sends data while visible. |
| `linkViews.ts` | Backlinks and Outgoing Links tree views |
| `statusBar.ts` + `shared/stats.ts` | Word, character, backlink and outgoing-link counts |
| `colorConfig.ts` + `shared/colors.ts` | Loads `.diamond/graph.yml` (or `.json`) and matches folders and glob patterns (`shared/glob.ts`) |
| `preview.ts` | markdown-it plugin so VS Code's built-in preview renders wikilinks, embeds, highlights and task boxes |
| `webviewUtil.ts` | `nonce()`, `activeTabUri()` |

### Webviews

| File | Responsibility |
| --- | --- |
| `src/webview/liveEditor.ts` | CodeMirror 6 editor: custom lezer extensions (Highlight `==x==`, WikiLink/WikiEmbed, Tag), a ViewPlugin for inline decorations, a StateField for table widgets, an `ImageWidget`, clipboard handling, and the probe used by the tests |
| `src/webview/toolbar.ts` | Formatting toolbar (heading select, inline styles, lists, link, code block, table, divider). Only touches the DOM when the active state changes. |
| `src/webview/icons.ts` | Inline codicon SVGs |
| `media/graph.js` | Graph canvas: Barnes–Hut force layout, local mode (focus node pinned at the origin), arrows, legend, collapsible ☰ filters, Fit |
| `media/liveEditor.css`, `media/graph.css` | Webview styles (they use VS Code theme variables) |

## How the key pieces work

### Live editor sync protocol

The live editor is a `CustomTextEditorProvider` backed by the normal `TextDocument`, so saving, dirty markers, Git, undo and the source editor all keep working.

1. The extension sends the full text (normalised to `\n`) with a sequence number (`init`/`update`).
2. The webview sends edits as **line/column** changes plus the last sequence number it saw. Line/column positions mean the same thing in LF and CRLF files; character offsets did not, which caused the old "Enter jumps up" bug.
3. The extension applies the edits in a `WorkspaceEdit`, converting `\n` to `\r\n` for CRLF files. If the sequence number is stale, or the document version moved by more than our own edit, it resyncs by sending the full text again.
4. External changes (source editor, undo, Git) are pushed with `update`. An `applying` flag stops our own edits from echoing back.
5. Toolbar commands that need a VS Code picker run only after `await queue`, so pending keystrokes land first.

### Clipboard

VS Code's built-in copy/paste commands act on a hidden editor when a custom editor is focused. The webview therefore intercepts Ctrl/Cmd+C/X/V itself and bridges through `vscode.env.clipboard` (`clipboardWrite` / `clipboardRead` messages). With nothing selected, copy and cut take the whole line.

### Images in the live editor

The live editor renders:
- Markdown images, including the `![alt|300](path)` size shorthand.
- `![[embeds]]`.
- HTML `<img>` tags; `<p align="center">` is respected.
- Badges (images inside links).
- Images inside table cells.

The extension resolves paths and returns `asWebviewUri` URLs. Local resource roots include the workspace folders and the document's folder.

### Rename handling

`onWillRenameFiles` computes link rewrites for every note pointing at the moved files or folders, including relative links inside the moved notes. Changed files are saved silently. Files that were already dirty are updated but left unsaved. This is controlled by `diamond.updateLinksOnRename`.

### Graph

The sidebar view (`diamond.graphView`) is a live local graph of the open file (depth 1). The full graph panel (Ctrl+Alt+G) opens in local mode by default. Files are drawn as squares and notes as circles. Folder colours come from `.diamond/graph.yml`. Filter state, including whether the ☰ filter panel is open, is persisted per view with `vscode.setState`.

## Testing

| Kind | How to run | What it covers |
| --- | --- | --- |
| Unit | `npm test` | Parser, formatting, stats, colours, mini YAML, glob |
| Integration (real VS Code) | `test/integration/index.js`, run with the VS Code test runner against `sample-docs` | Links, source formatting, live editor, rename, folder move, open-by-default, CRLF, images, clipboard, save-on-switch, sidebar graph and graph |
| Browser harnesses | Serve the repo with `node scripts/serve.mjs` (port 8766), then open `test/live-harness.html` or `test/graph-harness.html` (`?compact` gives the sidebar layout) | Visual work on the webviews without launching VS Code |

Integration test tips:
- Launch with a fresh `--user-data-dir` every run. A leftover instance locks the profile and the run hangs.
- The internal command `diamond._probeLiveEditor` lets tests read which images the focused live editor rendered (and set the selection). It is not in `package.json`, so users never see it.
- The rename-back test has been flaky once or twice. `syncOpenDocuments()` fixed most of it; if it fails, re-run before digging in.

## Packaging and publishing

1. Bump `version` in `package.json` and add a `CHANGELOG.md` section. The Marketplace rejects a version that has already been published.
2. Run `npm run package`, which creates `diamond-documentation-<version>.vsix` (about 15 files, ~230 KB). Install it locally to smoke-test: *Extensions → … → Install from VSIX*.
3. Publish one of two ways:
   - Upload the `.vsix` at https://marketplace.visualstudio.com/manage (publisher `christian-jaimes`).
   - Run `npx vsce login christian-jaimes` with an Azure DevOps Personal Access Token (scope: *Marketplace → Manage*), then `npm run publish`. Never commit the token.

Packaging gotchas:
- **Always use `--no-dependencies`** (the scripts already do). Without it, vsce runs `npm list`, which can mangle some paths (e.g. folders with GUID-like names). Then it matches no files and fails with *"Extension entrypoint(s) missing"*. We have no runtime dependencies, so nothing is lost.
- `.vscodeignore` keeps sources, tests, `sample-docs`, scripts, `node_modules`, source maps, `media/logo.svg` and `media/graph.js` out of the package. `media/graph.js` is excluded because the bundled copy is `dist/graph.js`. If you add a runtime file, check it is not excluded.
- README images must be **https** to show on the Marketplace/Extensions page. vsce rewrites relative image links to `https://github.com/christian-jaimes/diamond-documentation/raw/HEAD/...` using the `repository` field. So a new image only shows once it is **pushed** to GitHub.
- vsce also rewrites `[text](path)` *examples* in the README into GitHub links. That is why the README writes them as `<code>[text]&#40;path)</code>`.

## Conventions

- **Line endings:** `.gitattributes` sets `* text=auto eol=lf`. The extension itself must work with both LF and CRLF user files; the integration suite has a CRLF check.
- **Naming:** commands, settings and views use the `diamond.` prefix. Internal-only commands start with `diamond._`.
- **Keybindings** for formatting use the when-clause `editorTextFocus && editorLangId == markdown || activeCustomEditorId == 'diamond.liveEditor' && !sideBarFocus && !panelFocus && !auxiliaryBarFocus`, so they fire in both editors but never in side panels.
- **Webview security:** every webview has a strict CSP with a per-load nonce (`webviewUtil.nonce()`). Do not add inline scripts without the nonce. `openExternal` only allows `http(s)` and `mailto`.
- **Toolbar commands:** the live editor can only run commands in `TOOLBAR_COMMANDS` (`src/liveEditor.ts`). Add new ones there.
- **Product identity:** the product is "Diamond Documentation". Keep naming and docs self-contained; do not reference other note-taking apps.
- **Commits:** small, descriptive messages, pushed to `main`. Update `CHANGELOG.md` with every user-visible change.

## Settings reference

| Setting | Default |
| --- | --- |
| `diamond.updateLinksOnRename` | `true` |
| `diamond.liveEditor.openByDefault` | `true` |
| `diamond.liveEditor.toolbar` | `true` |
| `diamond.liveEditor.readableLineLength` / `fontSize` / `fontFamily` | |
| `diamond.statusBar.enabled` | `true` |
| `diamond.exclude` | `**/{node_modules,.git}/**` |
| `diamond.newNoteFolder` | *(empty: next to the current note)* |
| `diamond.graph.showFiles` / `showOrphans` | `true` |
| `diamond.listContinuation` | `true` |

## Known limitations

- The live editor is a webview, so VS Code features that need a real text editor (multi-cursor commands from other extensions, the minimap, Copilot inline suggestions) only work in the source view (Ctrl+Shift+V).
- Git diffs always use the normal text diff, by design.
- Any tab that VS Code opens as a text editor is redirected to the live editor, unless the file is dirty or the user asked for the source view in that tab.

## Where to start

1. Run the extension with F5 on `sample-docs` and try every feature listed in the README.
2. Read `src/extension.ts`, then `linkIndex.ts`. Most features hang off the index.
3. For live editor work, use `test/live-harness.html` for fast iteration, then confirm in real VS Code.
4. Run `npm test` and the integration suite before pushing.
