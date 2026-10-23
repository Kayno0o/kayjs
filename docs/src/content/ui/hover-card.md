---
description: A card anchored to whichever element the page picks at run time, shown on hover or focus.
---

<Demo name="hover-card/basic" />

`anchor` is the element the card sits beside, or `undefined` for none: the card shows while there is one. The page sets it from `onPointerEnter` and `onFocus` and clears it on `onPointerLeave` and `onBlur`, so one card serves many elements. An element inside an SVG works too, the card following it as the plate pans or zooms.

The card never takes the pointer, so it cannot cancel the hover that shows it. For content to click, use [Popover](/ui/popover). The card is a plain `div`: while it shows, its `id` is added to the anchor's `aria-describedby` so a screen reader hears it, and Escape closes it until the anchor changes.

## Placement

`placement` is `top` (the default), `bottom`, `left`, `right`, or `top-start`, `top-end`, `bottom-start`, `bottom-end`, flipped by the browser when there is no room.

## Id

`id` is the card's id, unique on the page. kay draws one when you give none.
