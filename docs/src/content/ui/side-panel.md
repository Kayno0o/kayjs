---
description: A modal panel along the edge of the screen, with a head, a body and an optional footer.
---

<Demo name="side-panel/basic" />

## Controlled

`open` shows the panel and `onClose` is called however it closes: its close button, a click outside or Escape. Set `open` back to `false` there.

## Head actions

`@actions` adds controls to the head line, before the close button, such as previous and next.

<Demo name="side-panel/actions" />

## Title and close label

`title` is required and heads the panel. `closeLabel` names the close button for screen readers, `Close` by default.
