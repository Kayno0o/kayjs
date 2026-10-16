---
description: A markdown textarea that writes like an editor, with shortcuts and image uploads.
---

<Demo name="markdown-editor/basic" />

## Shortcuts

Ctrl or Cmd with B, I or K wraps the selection in bold, italics or a link, Enter continues a list and Tab indents a list item. Escape then Tab leaves the field from a list item too, which `keysHint` tells screen readers. A page pasted as HTML turns into markdown. `onInput` reports the text after every change.

## Image uploads

With `onImage(file)`, a pasted or dropped image is embedded behind a placeholder at once and swapped for its url once the function resolves. If it throws, the placeholder is removed and `uploadFailure` is toasted. `name` submits the text in a plain form.

<Demo name="markdown-editor/upload" />

## Start text

`value` is the text to start with. An editor whose parent passes other text follows it.
