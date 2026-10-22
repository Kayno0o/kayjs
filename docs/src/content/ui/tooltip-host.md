---
description: Renders the tooltip of any element carrying a data-tooltip attribute.
---

<Demo name="tooltip-host/basic" />

Render one `TooltipHost` in the root layout, then add `data-tooltip` to any element. It shows on hover and on keyboard focus. The pointer can cross onto the tooltip to read it, and Escape closes it until the pointer or the focus moves on. While a tooltip shows, its element points at it with `aria-describedby`, so a screen reader reads the tooltip too. A tooltip on an element the keyboard never reaches is not read this way, and the `unreachable-tooltip` check says so.

<Callout type="note">

`showDelay` and `hideDelay` set how long a tooltip waits before it shows and before it hides, `80ms` and `150ms` by default, as a duration with its unit, never a bare number: `TooltipHost(showDelay="300ms")`.

This page already renders the `TooltipHost`.

</Callout>

## Hints on read-only text

`data-hint` is a tooltip for the pointer alone, for the explanation of a figure the keyboard has no stop on, such as a stat. It shows on hover, never on focus, and `unreachable-tooltip` leaves it alone. It must only add to what the element already says, as neither the keyboard nor a screen reader brings it up.

## Placement

`data-tooltip-placement` sets where the tooltip sits, as a CSS `position-area`: `top` by default, or `bottom`, `left`, `right`.

<Demo name="tooltip-host/placement" />

## Icon buttons

An `IconButton` sets `data-tooltip` to its `label`, so an icon-only button names itself with no extra markup.

<Demo name="tooltip-host/icon-button" />
