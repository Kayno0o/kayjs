---
description: A multi-series line chart with a hover tooltip, drawn by chartist.
---

<Demo name="line-chart/basic" />

<Callout type="note">

The chart is drawn by chartist, which the app installs with `bun add chartist`. The server renders its frame, the keyboard slider, the table screen readers read and the legend, and the drawing happens once the island mounts.

</Callout>

## Colors, legend and formatting

A series takes an optional CSS `color`, otherwise the next `--color-kui-chart-*` token, and every line after the first is dashed in its own pattern, which the legend shows, so the series stay apart without their colours. `legend` names the series under the chart, by default once there is more than one. `formatValue` formats the y-axis, the tooltip and what screen readers hear.

A label that is a date, such as `2026-10-21` or `2026-10-21T16:12:12Z`, heads the tooltip as a date in the page's language, with its time when it has one and its seconds when points are under a minute apart.

A span under a day labels the x-axis with times. The tooltip keeps its width and stays inside the window, flipping below the pointer near the top.

`formatLabel(label, context)` writes the heading and the x-axis labels itself, for labels that are not dates or a format of your own. The context tells which point it is (`index`), whether the label heads the tooltip or sits on the axis (`place`, `'tooltip'` or `'tick'`), how many milliseconds the labels span (`span`) and whether points are under a minute apart (`seconds`).

<Demo name="line-chart/formatted" />

## Stacking series

`stacked` draws each series on top of the ones before it and fills the band between two lines, so the top line reads the total. It suits parts of a whole, such as one line per CPU core, each its share of the machine. The y-axis starts at 0 and reaches the highest total (`options.low` overrides the start).

The tooltip, the keyboard announcements and the table for screen readers still read each series' own value through `formatValue`, never the running sum, and add a total. A `null` reads `-` and counts as 0 in the total, so a stacked line never breaks at a gap. The axis reaches below 0 when a total does. `totalLabel` renames the total, which is `Total` by default and read from the `ui.lineChart.total` word.

## Picking a span

`onRange(from, to)` lets a drag across the plot, or Shift with the arrow keys then Enter, pick a span and hands over the indices of its first and last points, such as to zoom in on them; Escape drops a span under way, and `rangeHint` is what screen readers are told about the keys. A `null` value in a series leaves a gap in the line.

<Demo name="line-chart/range" />

## Keyboard and screen readers

`label` names the chart. Screen readers read every value from a table only they see, one row per label and one column per series (and a total column when stacked), so a series of thousands of points renders as many rows. The plot is one stop in the tab order: the arrows walk the points, Home and End reach either end, chords such as Alt with an arrow stay the browser's, and each step shows the tooltip and announces the point's label and readings.

## Data and axes

`labels` is the x-axis labels, one per point of every series. `xLabels` draws them under the plot, up to five, spaced by time when every label is a date. `options` is merged over the chart's defaults, for what the props do not cover.
