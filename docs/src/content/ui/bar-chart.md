---
description: Vertical bars over a time or category axis, a bar's colour coming from its own status.
---

<Demo name="bar-chart/basic" />

A series has a `name` and one value per label, and the bars draw in plain HTML on the server, no peer needed. Only positive readings draw a bar: a `null`, a zero or a negative value leaves its column empty. A label that is a date reads in the page's language, as in LineChart, but the bars sit evenly apart rather than at their real distance in time.

`xLabels` draws up to five labels under the bars. `formatValue` formats the y-axis, the tooltips and what screen readers hear, `formatLabel(label, context)` the x-axis labels and the tooltip headings, as LineChart's does, and `legend` names the series under the chart, by default once there is more than one.

## Colour and notes per bar

A series takes an optional CSS `color`, otherwise the next `--color-kui-chart-*` token. `colors` gives one colour per label and wins over it, so a bar can show its status, and `notes` adds one message per label to that bar's tooltip. A column with no height keeps a short stub where its series gives it a `colors` entry or a `notes` one, so a failed run recorded as 0 still shows. A colour is no cue for everyone, so give a failed bar a note.

<Demo name="bar-chart/status" />

## Stacking series

`stacked` piles the series of a label on one bar, scaled to the highest total, and adds a total to the tooltip, named by `totalLabel` (`Total` by default, read from the `ui.barChart.total` word).

<Demo name="bar-chart/stacked" />

## Keyboard and tooltips

The columns are one tab stop on the latest one, the arrows walking the others and Home and End reaching either end. Hovering or focusing a column shows a tooltip reading the label, each series' value and its notes, which screen readers hear as well. The tooltip needs a TooltipHost on the page, which `ui()` mounts.

`--kui-bar-chart-height` sets the plot's height, `12rem` by default.

## Empty

With no labels, the chart reads `emptyLabel` instead, `No data yet.` by default.
