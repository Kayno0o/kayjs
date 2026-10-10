---
description: A multi-series line chart with a hover tooltip, drawn by chartist.
---

<Demo name="line-chart/basic" />

<Callout type="note">

The chart is drawn by chartist, which the app installs with `bun add chartist`. The server renders its frame and legend, and the drawing happens once the island mounts.

</Callout>

## Colors, legend and formatting

A series takes an optional CSS `color`, otherwise the next `--color-kui-chart-*` token. `legend` names the series under the chart, by default once there is more than one. `formatValue` formats the y-axis and the tooltip.

<Demo name="line-chart/formatted" />

## Picking a span

`onRange(from, to)` lets a drag across the plot pick a span and hands over the indices of its first and last points, such as to zoom in on them. A `null` value in a series leaves a gap in the line.

<Demo name="line-chart/range" />
