---
description: A button that copies a text to the clipboard and confirms it.
---

<Demo name="copy-button/basic" />

`text` is what is copied and `label` names the button. For `copiedFor` after a successful copy, two seconds by default and a duration with its unit such as `500ms`, it reads `copiedLabel` (`Copied!` by default), and `failure` is toasted when the browser refuses. A status region after the button, visually hidden, says `copiedLabel` too, as screen readers do not read a button's new text: the component renders these two elements.

Both labels sit inside the button, in a `.kui-copy-btn-text` span, the one not showing hidden from sight and from screen readers, so the button keeps the width of the wider one through the copy. The shorter label is centred in that width.

## Rich text

`html` is copied alongside `text`, which is what rich editors paste.

<Demo name="copy-button/html" />

## Variant

It takes a Button's `variant`, `tone` and `size`.
