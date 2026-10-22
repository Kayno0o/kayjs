---
description: A panel along the edge of the screen, with a head, a body and an optional footer.
---

<Demo name="side-panel/basic" />

## Controlled

`open` shows the panel and `onOpenChange(false)` is called however it closes: its close button, a click outside or Escape. Set `open` back to `false` there.

## Head actions

`@actions` adds controls to the head line, before the close button, such as previous and next.

<Demo name="side-panel/actions" />

## Title and close label

`title` is required and heads the panel. `closeLabel` names the close button for screen readers, `Close` by default.

## Beside the page

`modal={false}` shows the panel beside the page instead of over it. The page under it stays interactive and a click outside leaves it open.

Escape and the close button still close it through `onOpenChange(false)`. It renders open on the server, so a page driven by the URL shows it with no JavaScript.

<Demo name="side-panel/beside" />

`closeHref` makes the close button a link to that URL, so such a page closes it with no JavaScript too. With JavaScript it still calls `onOpenChange(false)`.
