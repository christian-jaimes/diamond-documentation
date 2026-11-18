# Changelog

## Unreleased

- **Paste a URL over selected text to make a link** in the live editor: the selection becomes `[text](url)`.
- **Table of contents.** A toolbar button (after the divider) and the command **Diamond: Insert / Update Table of Contents** (both editors) builds a linked, nested list of the note's headings between `<!-- toc -->` and `<!-- /toc -->`. The list is refreshed on save; turn that off with `diamond.toc.updateOnSave`.
- **Table navigation.** Tab / Shift+Tab move between table cells in both editors without changing the text (use Format Table to align); Tab in the last cell adds a row. Outside tables Tab behaves as before.
- **Ordered lists renumber themselves** in the live editor when items are added, removed or moved.

- **Spell checking in the live editor.** Misspellings reported by the Code Spell Checker extension are underlined in the live editor; hover for the message and Quick Fixes (suggestions, add to dictionary…). Nothing is shown if the extension isn't installed. New setting `diamond.liveEditor.diagnostics` (`spelling` by default, `all`, `off`).
- **`[[` autocomplete in the live editor.** Typing `[[` suggests every file in the workspace (notes, code, images… with fuzzy matching on name and path); choosing one completes the link and its closing `]]`. Type `#` after a note name (`[[Storage#`) to pick one of its headings. The popup uses your theme's suggest-widget colours. The source editor already offered the same completions, including headings.
- **Auto-closing brackets in the live editor:** typing `(`, `[`, `{` or `"` inserts the closing character. Typing the closer skips over it, Backspace on an empty pair removes both, and typing an opener over selected text wraps it. A `"` right after a word character (as in `don"t`) is left alone. Turn it off with `diamond.liveEditor.autoCloseBrackets`; the source editor follows VS Code's `editor.autoClosingBrackets`.
- **Find and replace in the live editor now looks and works like VS Code's own** (Ctrl/Cmd+F): a floating widget in the top-right with inline Match Case, Whole Word and Regex toggles, an "N of M" / "No results" counter, previous/next buttons, Find in Selection, a close button and a collapsible replace row (Replace and Replace All). Enter / Shift+Enter / F3 move between matches, Escape closes, Ctrl/Cmd+H opens it with Replace shown, and Alt+C / Alt+W / Alt+R / Alt+L toggle the options. It uses your theme's colours.
- **Graph:** nodes are now named by what they contain. A note shows its first `#` heading; notes without one, and other file types, show the parent folder and file name (for example `guides/setup`). Set `diamond.graph.nodeLabel` to `fileName` to show plain file names instead.
- Long graph labels are shortened, labels that would overlap are hidden, and hovering a node shows its full name and path.

## 0.4.4

- **Fixed:** copy, cut and paste (Ctrl/Cmd+C, X, V) now work in the live editor. With nothing selected, copy and cut take the whole line.
- Switching between the live editor and the Markdown source saves your changes first, so you are no longer asked "Save changes?".
- The graph's filters fold away behind the ☰ button, leaving just a small search box; the node and link counts moved to the bottom-left corner.
- The live editor toolbar no longer has the Local Graph and MD buttons (use the title-bar icons or Ctrl+Shift+V).

## 0.4.3

First public release.

- **Live editor**: Markdown opens in an editable, formatted view with a formatting toolbar; raw Markdown shows only on the lines you edit. Switch to the source with Ctrl+Shift+V.
- **Links to any file**: `[[wikilinks]]` and Markdown links to notes, code, SQL, images and binaries, with autocomplete, hover previews and go-to-definition.
- **Images**: Markdown images, `![[embeds]]`, HTML `<img>` tags, linked badges and images in tables.
- **Rename-safe links**: renaming or moving a file or folder updates every link to it and saves the changed files.
- **Graph**: a side bar graph that follows the open file, plus a full graph view, with Docs/Files filters, folder colours from `.diamond/graph.yml` and an optional legend.
- **Backlinks and outgoing links** panels, and word, character and link counts in the status bar.
