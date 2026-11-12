---
description: A modal dialog driven by an open flag, with a title, a close button and a footer.
---

<Demo name="dialog/basic" />

## Open and close

`open` shows the dialog as a modal. The parent owns it: set it to true to open, and back to false in `onOpenChange`. `onOpenChange(false)` runs however the dialog closed, Escape and a click outside included. Every disclosure takes `open` and `onOpenChange`.

Leave `open` out and the dialog keeps its own state, opened by a `@trigger` block that spreads the attributes it is handed. `onOpenChange` is then optional, and still called with `true` on opening and `false` on every close.

```kay
Dialog(title="Rename")
  @trigger(attributes)
    button({...attributes}) Rename
  p Pick a new name.
```

The `@footer` block holds the buttons. The content renders only while the dialog is open.

## Typed work is kept

Typing inside marks the dialog as edited. Escape, a click outside and the close button then ask "Discard changes?" through [`confirm()`](/ui/confirm-delete#from-code), and close the dialog only once the reader says so.

<Demo name="dialog/edited" />

`discard` words the question, `{ title, message, confirmLabel, cancelLabel }`, and `discard={false}` locks the close instead: only the dialog's own buttons close it. Set `autosave` when the fields save as they are typed: typing then asks nothing, and a click outside or Escape closes the dialog as before anything was typed. `dirty` still locks it. SidePanel asks the same way.

## Work in progress

Set `dirty` for other work the dialog must not drop, such as a request in flight.

<Demo name="dialog/dirty" />

## Size and bare content

`size` is the width: `sm`, `md` (the default) or `lg`, and `full` fills the viewport less its margin in both directions. `bare` drops the body's inset and scroll, as Card's does, for content that runs to the dialog's edge such as a pan and zoom canvas; give that content `h-full` to fill the body. The title and the footer keep their inset.

## Close button, links and parts

The head line holds the title, the `@actions` block and a close button, named `Close` or by `closeLabel`. The button closes through `onOpenChange(false)`, and is disabled while `dirty`. `@header` draws the whole head line yourself and `@close` replaces the button alone.

`closeHref` makes the close button a link, so a dialog open on the server closes with no JavaScript. With it `onOpenChange` is optional: leave it out and Escape follows the link too. `modal={false}` shows the dialog over the page without blocking it, open on the server, as SidePanel does.

SidePanel, FormDialog and CommandPalette take the same `size` names (a palette's `md` is the narrower 36rem), and FormDialog passes `size`, `level`, `actions`, `header`, `close`, `closeHref`, `modal` and `closeLabel` to its Dialog.

## Heading level

The title is an `h2`, as the dialog opens over the page's own `h1`. `level` sets another. It is a string or a `@title` block that draws markup in its place, such as an icon or a badge, the dialog then being named by that heading; `label` names it for screen readers when that differs from the visible title. SidePanel, FormDialog and ConfirmDelete take the same.

<ReadMore href="/ui/form-dialog">FormDialog wraps a Dialog around a form that calls a page's action.</ReadMore>
