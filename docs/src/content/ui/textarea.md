---
description: A multi-line text field that reports each keystroke and the committed value.
---

<Demo name="textarea/basic" />

`onInput` is called on each keystroke and `onChange` once the value is committed, on blur. Without `value`, the box starts empty and keeps what is typed, for a form posting it by its `name`. A `value` the page writes back, such as the text trimmed, lands once the box is left, never under the caret.

`writeFocused` lets any write land while the box is focused, such as a chat clearing its draft after a send, the caret going to the end. Other attributes such as `rows` and `placeholder` pass through to the textarea.
