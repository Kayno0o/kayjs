---
description: Vertical bars over a time or category axis, a bar's colour coming from its own status.
---

<Demo name="bar-chart/basic" />

A series has a `name` and one value per label, and the bars draw in plain HTML on the server, no peer needed. Only positive readings draw a bar: a `null`, a zero or a negative value leaves its column empty. A label that is a date reads in the page's language, as in LineChart, but the bars sit evenly apart rather than at their real distance in time.

`xLabels` draws up to five labels under the bars. `formatValue` formats the y-axis, the tooltips and what screen readers hear, `formatLabel(label, context)` the x-axis labels and the tooltip headings, as LineChart's does, and `legend` names the series under the chart, by default once there is more than one.

The gap between the columns is `--bar-gap` (`0.25rem`) and shrinks as the columns get narrow, so any number of labels fits the figure; set `--bar-gap` on the chart to change it. The first and the last x-axis label line up with the plot's edges and stay inside the figure.

The value axis spans the highest reading rounded up to 1, 2, 4, 6, 8 or 10 times a power of ten, so its three ticks are round numbers: 31 reads 0, 20 and 40.

## Colour and notes per bar

A series takes an optional CSS `color`, otherwise the next `--color-chart-*` token. With several series, each after the first is also hatched in its own pattern, on its bars and in the legend, so they stay apart without their colours. `colors` gives one colour per label and wins over it, so a bar can show its status, and `notes` adds one message per label to that bar's tooltip. A column with no height keeps a short stub where its series gives it a `notes` entry, or a `colors` one with a reading, so a failed run recorded as 0 still shows. A colour is no cue for everyone, so give a failed bar a note.

<Demo name="bar-chart/status" />

## Stacking series

`stacked` piles the series of a label on one bar, scaled to the highest total, and adds a total to the tooltip, named by `totalLabel` (`Total` by default, read from the `ui.barChart.total` word).

<Demo name="bar-chart/stacked" />

## Keyboard and tooltips

The columns are one tab stop on the latest one, the arrows walking the others and Home and End reaching either end. Hovering or focusing a column shows a tooltip reading the label, each series' value and its notes, which screen readers hear as well. The tooltip needs a TooltipHost on the page, which `ui()` mounts.

`--chart-height` sets the plot's height, `12rem` by default.

## Empty

With no labels, the chart reads `emptyLabel` instead, `No data yet.` by default.

## Marking events

`marks` takes the same events as LineChart's: `marks={[{ at: 'Tue', title: 'Schedule changed', href: '/changes/42' }]}` draws a dashed rule over the column at `at` (a label or an index into `labels`), its `title` joining that column's tooltip and what screen readers read. With an `href` the rule is a link and a tab stop beside the columns.

`onMark(mark, index)` makes a mark without an `href` a button, as in LineChart. An `at` that is no label is left out, and several on one column stand side by side.

## Pressing and linking

`onSelect` makes every column a button handing back its mark, and `href` returns an address for a mark (or `undefined`) that makes it a link, so a middle click or a crawler finds it; a plain click on a link still goes to `onSelect` when given. `onActive` hears the index the pointer or focus is on, `null` when it leaves, and `active` draws one as active, taking over from the pointer.

A `@tooltip` block replaces the built-in tooltip with the app's own content, shown over the mark the pointer or focus is on.
