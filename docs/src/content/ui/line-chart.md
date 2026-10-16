---
description: A multi-series line chart with a hover tooltip, drawn by chartist.
---

<Demo name="line-chart/basic" />

<Callout type="note">

The chart is drawn by chartist, which the app installs with `bun add chartist`. The server renders its frame, the keyboard slider, the table screen readers read and the legend, and the drawing happens once the island mounts.

</Callout>

## Colors, legend and formatting

A series takes an optional CSS `color`, otherwise the next `--color-kui-chart-*` token, and every line after the first is dashed in its own pattern, which the legend shows, so the series stay apart without their colours. `legend` names the series under the chart, by default once there is more than one. `formatValue` formats the y-axis, the tooltip and what screen readers hear.

<Demo name="line-chart/formatted" />

## Picking a span

`onRange(from, to)` lets a drag across the plot, or Shift with the arrow keys then Enter, pick a span and hands over the indices of its first and last points, such as to zoom in on them; Escape drops a span under way, and `rangeHint` is what screen readers are told about the keys. A `null` value in a series leaves a gap in the line.

<Demo name="line-chart/range" />

## Keyboard and screen readers

`label` names the chart. Screen readers read every value from a table only they see, one row per label and one column per series, so a series of thousands of points renders as many rows. The plot is one stop in the tab order: the arrows walk the points, Home and End reach either end, chords such as Alt with an arrow stay the browser's, and each step shows the tooltip and announces the point's label and readings.

## Data and axes

`labels` is the x-axis labels, one per point of every series. `xLabels` draws them under the plot, up to five, spaced by time when every label is a date. `options` is merged over the chart's defaults, for what the props do not cover.
