---
description: A figure and what it counts, as a compact badge.
---

<Demo name="stat/basic" />

## With an icon

`icon` names one of the library's icon slots, drawn before the figure.

<Demo name="stat/with-icon" />

## Tiles

`variant="tile"` draws a framed box with the figure above its label, for a grid of stats; the default `inline` is the pill.

<Demo name="stat/tile" />

## A link

`href` makes the whole stat a link, to the list it counts, so middle-click and a new tab work. It takes the hover and focus of a button.

## Change from the previous period

`delta` shows how the figure moved, beside it: `value` as you word it (`+12%`), an optional `label` for what it is measured against (`vs previous`) and a `tone`. The arrow follows the sign of `value`, up for `+`, down for `-` and flat for anything else; `direction` (`up`, `down` or `flat`) picks it when the sign cannot, such as `12%` for a rise. The arrow and the sign carry the direction, so colour is never the only signal.

Whether up is good is yours to say: `tone="danger"` on a rise in errors, `success` on a rise in visits. Without a `tone` the change stays muted. The arrows are the `trendUp`, `trendDown` and `trendFlat` icon slots.

<Demo name="stat/delta" />

## Tone

`tone` colours the figure alone: `accent`, `success`, `warning`, `danger` or `info`, `neutral` by default. Choose it from the data, such as `danger` past a threshold, and the label keeps its colour.

## Figure and label

`value` is the figure, a number or a string, and `label` says what it counts, read together as "12 moons". Without a `label`, only the figure is drawn.
