---
description: Weighted points on two axes, with optional quadrant guides.
---

<Demo name="scatter-chart/basic" />

## Axes

A point has a `key`, a `label`, `x` and `y`, and a `weight` its dot's area follows. Each axis takes a `label`, a `domain`, a `scale` of `linear` or `log` and custom `ticks`.

## Quadrants

`quadrant` draws guides through a point and `corners` names the four regions they split. `onSelect(point)` makes each dot a button, from an island.
