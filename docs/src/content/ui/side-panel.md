---
description: A panel along the edge of the screen, with a head, a body and an optional footer.
---

<Demo name="side-panel/basic" />

## Controlled

`open` shows the panel and `onOpenChange(false)` is called however it closes: its close button, a click outside or Escape. Set `open` back to `false` there.

## Scroll position

A panel kept in place while its content changes, such as one in a `persist` island that shows the next item of a list, keeps the scroll of its body. Give `scrollKey` a value that names the content, an id for instance, and the body goes back to the top whenever it changes.

## Head actions

`@actions` adds controls to the head line, before the close button, such as previous and next.

<Demo name="side-panel/actions" />

## Title and close label

`title` is required and heads the panel. `closeLabel` names the close button for screen readers, `Close` by default.

## Beside the page

`modal={false}` shows the panel beside the page instead of over it. The page under it stays interactive and a click outside leaves it open.

Escape and the close button still close it through `onOpenChange(false)`. It renders open on the server, so a page driven by the URL shows it with no JavaScript.

<Demo name="side-panel/beside" />

## Docked

`dock="right"` or `"bottom"`, with `modal={false}`, docks the panel to that edge as a tool beside the page. The page's `body` is given room by the panel's size (a right margin, or bottom padding), the panel sits beside the dev tool's docked drawer, and a grip on its inner edge resizes it with the pointer or the arrow keys (Shift moves four steps). The panel and the page each keep a minimum of the window.

`size` is the width, or the height at the bottom, in pixels, and `onSizeChange(size, settled)` tells the parent each size the grip reached: `settled` is false while a drag is under way and true when it ends or a key moved it, so keep it then. Only the close control closes a docked panel, Escape does not.

`sizeKey="pane"` keeps the size the grip settled on in a cookie of that name, with no handler and no signal of your own. The server reads the cookie too, so the panel is drawn at the saved width from the first paint, with no jump on load. A `size` you give wins over it.

The panel publishes its size on `html` as `--kui-dock-right` or `--kui-dock-bottom`, and as `--kay-panel-right` or `--kay-panel-bottom` for the dev tool's bar to keep out of. A fixed header across the top is cleared by setting `--kui-dock-top` on `html`, and a `style` sets the panel's `z-index`. `resizeLabel` names the grip, `Resize` by default.

`launcher` is the label of a button the closed panel leaves in the window's bottom right corner, off the dev tool's drawer, which opens it through `onOpenChange(true)`; `launcherLayer` sets its `z-index`, the one thing of it a parent sets, as the panel's `style` does not reach it. It names the panel it opens through `aria-controls`, the panel's `id`, and publishes its room as `--kay-panel-right`.

`launcherHref` makes the launcher a link to that URL instead, so a panel driven by the URL opens with no JavaScript too; a panel with a `closeHref` and no `onOpenChange` must give one with its `launcher`, as nothing else could open it, and the types ask for it.

`closeHref` makes the close button a link to that URL, so such a page closes it with no JavaScript too. With JavaScript the link navigates and `onOpenChange(false)` is called as well, so its handler need not navigate.

With `closeHref`, `onOpenChange` is optional. Leave it out and a server page renders the panel with no island of its own: the link closes it, and Escape follows `closeHref` too.
