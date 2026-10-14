---
description: Renders the tooltip of any element carrying a data-tooltip attribute.
---

<Demo name="tooltip-host/basic" />

Render one `TooltipHost` in the root layout, then add `data-tooltip` to any element. It shows on hover and on keyboard focus. The pointer can cross onto the tooltip to read it, and Escape closes it until the pointer or the focus moves on.

<Callout type="note">

This page already renders the `TooltipHost`.

</Callout>

## Placement

`data-tooltip-placement` sets where the tooltip sits, as a CSS `position-area`: `top` by default, or `bottom`, `left`, `right`.

<Demo name="tooltip-host/placement" />

## Icon buttons

An `IconButton` sets `data-tooltip` to its `label`, so an icon-only button names itself with no extra markup.

<Demo name="tooltip-host/icon-button" />
