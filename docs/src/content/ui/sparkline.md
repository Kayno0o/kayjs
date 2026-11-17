---
description: Small bars, a line or an area with no axes, for a trend inside a row or a card.
---

<Demo name="sparkline/basic" />

`values` is one number per bar. The largest fills the height, and a `null`, a zero or a negative value leaves a hairline. The bars fill the width of their box, so size the box. `--spark-height` sets the height, `1.5rem` by default.

`label` is the one sentence a screen reader hears, such as the total and the peak. The bars are hidden from it, so a chart that says nothing in its label says nothing to them.

## A line or an area

`variant="line"` draws a thin line through the values in place of bars, and `variant="area"` tints the space under it. The line runs from the lowest value to the highest, so it shows the shape of the trend rather than the size of each value. A `null` splits the line in two instead of dropping to zero, and a value between two gaps is drawn as a dot.

<Demo name="sparkline/area" />

The pointer and the keyboard still land on one value at a time, `hints`, `onSelect`, `href` and `onActiveChange` working as on bars, with a dot on the active value. `line` and `area` are the parts to restyle in `src/ui.ts`, beside `plot`, the SVG that holds them, and `point`, the dot.

## Tone

`tone` colours every bar, or the line and its area, `accent` by default; `color` takes any CSS colour in its place. `tones` gives one tone per bar (or per dot on a line) and wins over it, so a slow check can stand out. `neutral` (a quiet grey), `accent`, `success`, `warning`, `danger` and `info` are the tones. A colour is not a cue for everyone, so say what the tone means in `label`.

<Demo name="sparkline/tones" />

## A note per bar

`hints` gives one note per bar, shown under the pointer by [TooltipHost](/ui/tooltip-host). The keyboard has `label` alone, which is why the notes are not tooltips on tab stops.

For axes, a legend and a tooltip a keyboard reaches, use [BarChart](/ui/bar-chart).

## Pressing and linking

`onSelect` makes every bar a button handing back its mark, and `href` returns an address for a mark (or `undefined`) that makes it a link, so a middle click or a crawler finds it; a plain click on a link still goes to `onSelect` when given. `onActiveChange({ index })` hears the index the pointer or focus is on, `null` when it leaves, and `active` draws one as active, taking over from the pointer.
