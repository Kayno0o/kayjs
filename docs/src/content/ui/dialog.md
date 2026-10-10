---
description: A modal dialog driven by an open flag, with a title and a footer.
---

<Demo name="dialog/basic" />

`open` shows the dialog as a modal. The parent owns it: set it to true to open, and back to false in `onClose`, which runs however the dialog closed, Escape and a click outside included. The `@footer` block holds the buttons.

<Callout type="note">

The content renders only while the dialog is open. Typing inside marks it as edited, so a click outside or Escape no longer closes it; set `dirty` for other work it must not drop, such as a request in flight.

</Callout>

<ReadMore href="/ui/form-dialog">FormDialog wraps a Dialog around a form that calls a page's action.</ReadMore>
