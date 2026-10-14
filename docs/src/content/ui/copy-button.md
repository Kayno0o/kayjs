---
description: A button that copies a text to the clipboard and confirms it.
---

<Demo name="copy-button/basic" />

`text` is what is copied and `label` names the button. For two seconds after a successful copy it reads `copiedLabel` (`Copied!` by default), and `failure` is toasted when the browser refuses. A status region beside it says `copiedLabel` too, as screen readers do not read a button's new text.

## Rich text

`html` is copied alongside `text`, which is what rich editors paste.

<Demo name="copy-button/html" />
