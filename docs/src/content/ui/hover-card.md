---
description: A card shown beside an element on hover or focus, from a trigger or an element the page picks at run time.
---

<Demo name="hover-card/basic" />

## Trigger

For one element, the `@trigger(attributes)` block renders it, spreading the `attributes` it is handed as on [Popover](/ui/popover): `@trigger(attributes)`, then `button({...attributes})`. The card shows when the pointer rests on it for `openDelay` (200 ms) or when it is focused, and stays `closeDelay` (150 ms) after either leaves, so the pointer can cross onto the card. `open` shows it from the page, and setting it back to `false` hides it.

## Anchor

`anchor` is the element the card sits beside, or `undefined` for none: the card shows while there is one. The page sets it from `onPointerEnter` and `onFocus` and clears it on `onPointerLeave` and `onBlur`, so one card serves many elements. An element inside an SVG works too, the card following it as the plate pans or zooms.

The pointer can move onto the card: when your code clears the anchor, the card waits a moment and stays while the pointer is on it, so its text can be read at length (WCAG 1.4.13). For content to click, use [Popover](/ui/popover). The card is a plain `div`: while it shows, its `id` is added to the anchor's `aria-describedby` so a screen reader hears it, and Escape closes it.

## Hearing it close

`onOpenChange({ open })` is called with `true` as the card shows and `false` as it hides. It also runs when the card hides itself, on Escape or when the anchor left the page, while your code still holds the anchor. Clear the anchor there, so your state says "closed" and the same element can show the card again.

## Placement

`placement` is `top` (the default), `bottom`, `left`, `right`, each also with `-start` or `-end`, flipped by the browser when there is no room. It is the same `Placement` as on Popover.

## Id

`id` is the card's id, unique on the page. kay draws one when you give none.
