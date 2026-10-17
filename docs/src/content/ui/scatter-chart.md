---
description: Weighted points on two axes, with optional quadrant guides.
---

<Demo name="scatter-chart/basic" />

## Axes

A point has a `key`, a `label`, `x` and `y`, and a `weight` its dot's area follows. Each axis takes a `label`, a `domain`, a `scale` of `linear` or `log` and custom `ticks`, each one a `value` with its `label`.

<Demo name="scatter-chart/axes" />

## Quadrants

`quadrant` draws guides through a point and `corners` names the four regions they split.

## Selecting a point

`onSelect(point)` makes each dot a button handing back its point, from an island.

<Demo name="scatter-chart/select" />

## Empty

`emptyLabel` is what the chart reads with no points, `No data yet.` by default. `empty` is its deprecated name.
