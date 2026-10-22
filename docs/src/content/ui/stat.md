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

## Tone

`tone` colours the figure alone: `accent`, `success`, `warning`, `danger` or `info`, `neutral` by default. Choose it from the data, such as `danger` past a threshold, and the label keeps its colour.

## Figure and label

`value` is the figure, a number or a string, and `label` says what it counts, read together as "12 moons". Without a `label`, only the figure is drawn.
