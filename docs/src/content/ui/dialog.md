---
description: A modal dialog driven by an open flag, with a title and a footer.
---

<Demo name="dialog/basic" />

## Open and close

`open` shows the dialog as a modal. The parent owns it: set it to true to open, and back to false in `onOpenChange`. `onOpenChange(false)` runs however the dialog closed, Escape and a click outside included. Every disclosure takes `open` and `onOpenChange`.

The `@footer` block holds the buttons. The content renders only while the dialog is open.

## Typed work is kept

Typing inside marks the dialog as edited, so a click outside or Escape no longer closes it and only its own buttons do.

<Demo name="dialog/edited" />

## Work in progress

Set `dirty` for other work the dialog must not drop, such as a request in flight.

<Demo name="dialog/dirty" />

## Size and bare content

`size` is the width: `sm`, `md` (the default) or `lg`, and `full` fills the viewport less its margin in both directions. `bare` drops the body's inset and scroll, as Card's does, for content that runs to the dialog's edge such as a pan and zoom canvas; give that content `h-full` to fill the body. The title and the footer keep their inset.

## Heading level

The title is an `h2`, as the dialog opens over the page's own `h1`. `level` sets another.

<ReadMore href="/ui/form-dialog">FormDialog wraps a Dialog around a form that calls a page's action.</ReadMore>
