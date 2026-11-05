---
description: A button that copies a text to the clipboard and confirms it.
---

<Demo name="copy-button/basic" />

`text` is what is copied and `label` names the button. For `copiedFor` after a successful copy, two seconds by default and a duration with its unit such as `500ms`, it reads `copiedLabel` (`Copied!` by default), and `failureLabel` is toasted when the browser refuses. A status region after the button, visually hidden, says `copiedLabel` too, as screen readers do not read a button's new text: the component renders these two elements.

The button keeps the width of the wider of `label` and `copiedLabel` through the copy: the label not showing is drawn invisibly beside the one showing, so the button's text and accessible name stay the visible label. The shorter label is centred.

## Rich text

`html` is copied alongside `text`, which is what rich editors paste.

<Demo name="copy-button/html" />

## Variant

It takes a Button's `variant`, `tone` and `size`.

## Text built on the click

`text` may be a function returning the text or a promise of it, for a value that has to be fetched or built when the button is pressed, such as a signed link. The copy still starts inside the click, so Safari accepts it. `onCopy(text)` is called with the text once it is copied, and `onError({ error })` when it could not be built or the browser refused it, beside the `failure` toast.
