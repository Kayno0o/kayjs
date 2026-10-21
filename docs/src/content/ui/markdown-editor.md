---
description: A markdown textarea that writes like an editor, with a toolbar, shortcuts, a preview and image uploads.
---

<Demo name="markdown-editor/basic" />

## Shortcuts

Ctrl or Cmd with B, I or K wraps the selection in bold, italics or a link, Enter continues a list and Tab indents a list item. Escape then Tab leaves the field from a list item too, which `keysHint` tells screen readers. A page pasted as HTML turns into markdown. `onInput` reports the text after every change.

## Toolbar

A toolbar over the field offers bold, italic, a heading, bulleted and numbered lists, a link and an image. Each acts on the selection like the shortcuts, and Ctrl+Z undoes it. `toolbar={false}` hides it.

A list keeps only the buttons it names, in its order: `toolbar={['bold', 'italic', 'link']}`. The other names are `heading`, `bulletList`, `numberedList` and `image`. The image button opens the file picker when `onImage` is given, and otherwise writes `![](url)` to fill in.

## Preview

`preview` is a function that takes the text and resolves with its HTML. Given, a Preview button shows the result beside the field, or in place of it when the editor is narrow.

<Demo name="markdown-editor/preview" />

The editor ships no Markdown parser: the function asks your server, so the preview is made by the same code as your pages.

```ts
// src/routes/api/preview.ts
import { s } from 'kay'
import { renderMarkdown } from 'kay/content'
import { api } from 'kay/server'

export default api().post('/', async ({ body }) => (await renderMarkdown(body.markdown)).html, { body: s.Object({ markdown: s.String() }) })
```

In the page, `preview={async markdown => call(preview, '/', { method: 'post', body: { markdown } })}`.

The HTML is inserted as it comes, so it must be your own renderer's output and not text a visitor sent. The preview waits for a short pause in typing, and if the call throws, the pane says it could not be shown. kayjs-cms does all of this for you.

## Image uploads

With `onImage(file)`, a pasted or dropped image is embedded behind a placeholder at once and swapped for its url once the function resolves. If it throws, the placeholder is removed and `uploadFailure` is toasted. `name` submits the text in a plain form.

<Demo name="markdown-editor/upload" />

## Start text

`value` is the text to start with. An editor whose parent passes other text follows it.
