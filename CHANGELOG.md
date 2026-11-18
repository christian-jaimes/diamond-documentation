# Changelog

## Unreleased

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
