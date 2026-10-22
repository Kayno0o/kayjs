---
description: Vertical bars over a time or category axis, a bar's colour coming from its own status.
---

<Demo name="bar-chart/basic" />

A series has a `name` and one value per label, and the bars draw in plain HTML on the server, no peer needed. Only positive readings draw a bar: a `null`, a zero or a negative value leaves its column empty.

`xLabels` draws up to five labels under the bars. `formatValue` formats the y-axis, the tooltips and what screen readers hear, `formatLabel(label, index)` the x-axis labels and the tooltip headings, and `legend` names the series under the chart, by default once there is more than one.

## Colour and notes per bar

A series takes an optional CSS `color`, otherwise the next `--color-kui-chart-*` token. `colors` gives one colour per label and wins over it, so a bar can show its status, and `notes` adds one message per label to that bar's tooltip.

<Demo name="bar-chart/status" />

## Stacking series

`stacked` piles the series of a label on one bar, scaled to the highest total, and adds a total to the tooltip, named by `totalLabel` (`Total` by default, read from the `ui.barChart.total` word).

<Demo name="bar-chart/stacked" />

## Keyboard and tooltips

Each column is a stop in the tab order. Hovering or focusing it shows a tooltip reading the label, each series' value and its notes, which screen readers hear as well.

## Empty

With no labels, the chart reads `emptyLabel` instead, `No data yet.` by default.
