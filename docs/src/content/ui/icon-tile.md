---
description: An icon, or a letter, on a small rounded tile tinted in a colour.
---

<Demo name="icon-tile/basic" />

`IconTile` marks a metric, a site or a feed by colour: the tile is the colour at 15% on the page, the icon is the colour itself. Children draw after the icon, or alone, such as a feed's first letter.

## Tone or any colour

`tone` is `neutral` (the default), `accent`, `success`, `warning`, `danger` or `info`. `color` takes any CSS colour, such as `#8fb8f4` or `oklch(0.7 0.1 250)`, and replaces the tone's: the tile derives its tint and its icon from it with `color-mix()`. A value that is no colour, such as one holding a `;`, is ignored.

<Demo name="icon-tile/colors" />

## Size

`size` is `sm`, `md` (the default) or `lg`.

## A link, a name

`href` makes the tile a link, and a link has no text to name it, so `label` is required with it: `kay check` fails for an `href` without one, and the label becomes its `aria-label`. Without an `href`, `label` is optional and the tile is decorative without it, the item's name being written beside it.

## In a Stat or a Widget

`iconTile` on [Stat](/ui/stat) and [Widget](/ui/widget) draws their `icon` as a tile: `true` for the neutral one, or an object of `tone`, `color` and `size`.

## Parts

`root` and `icon`; `tone`, `size` and `color` are the variants and the colour is one private property, `--tile-color`, that `class` or `src/ui.ts` can also set.
