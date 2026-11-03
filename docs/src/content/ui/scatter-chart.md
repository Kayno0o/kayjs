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

`emptyLabel` is what the chart reads with no points, `No data yet.` by default.

## Keyboard

Without `onSelect` the dots are one tab stop on the first. The arrows and Home and End walk them in the order of `points`, and each focused dot shows its tooltip. With `onSelect` every dot is a button.

## Pressing and linking

`onSelect` makes every dot a button handing back its mark, and `href` returns an address for a mark (or `undefined`) that makes it a link, so a middle click or a crawler finds it; a plain click on a link still goes to `onSelect` when given. `onActive` hears the index the pointer or focus is on, `null` when it leaves, and `active` draws one as active, taking over from the pointer.

A `@tooltip` block replaces the built-in tooltip with the app's own content, shown over the mark the pointer or focus is on.
