---
description: A panel anchored to a trigger, built on the browser's popover.
---

<Demo name="popover/basic" />

## Trigger and placement

The `@trigger(attributes)` block renders the button, which spreads the `attributes` it is handed. A click on it toggles the panel, and a click outside or Escape closes it. `placement` is `bottom-start`, `bottom-end`, `top-start` or `top-end`, flipped by the browser when there is no room.

## Controlled

`open` shows or hides the panel from the page, and `onToggle(open)` runs however it changed. A page driving `open` sets its own value back there.

<Demo name="popover/controlled" />
