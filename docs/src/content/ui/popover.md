---
description: A panel anchored to a trigger, built on the browser's popover.
---

<Demo name="popover/basic" />

## Trigger and placement

The `@trigger(attributes)` block renders the button, which spreads the `attributes` it is handed. A click on it toggles the panel, and a click outside or Escape closes it. `placement` is `bottom-start`, `bottom-end`, `top-start` or `top-end`, flipped by the browser when there is no room.

## Controlled

`open` shows or hides the panel from the page, and `onOpenChange(open)` runs however it changed. A page driving `open` sets its own value back there.

<Demo name="popover/controlled" />

## At a point

`at={{ x, y }}` opens the panel at a point of the window instead of against a trigger, and `@trigger` is then not needed. `open` shows it. A fixed anchor with no size stands at the point, so `placement` and the browser's flip apply as usual.

## Id

`id` is the panel's id, unique on the page. kay draws one when you give none.

## Anchored to another element

A Popover opens from its own trigger. For a card that follows the pointer or focus over many elements, with no trigger markup, use [HoverCard](/ui/hover-card).
