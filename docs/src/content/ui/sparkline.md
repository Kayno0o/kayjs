---
description: Small bars with no axes, for a trend inside a row or a card.
---

<Demo name="sparkline/basic" />

`values` is one number per bar. The largest fills the height, and a `null`, a zero or a negative value leaves a hairline. The bars fill the width of their box, so size the box. `--spark-height` sets the height, `1.5rem` by default.

`label` is the one sentence a screen reader hears, such as the total and the peak. The bars are hidden from it, so a chart that says nothing in its label says nothing to them.

## Tone

`tone` colours every bar, `accent` by default. `tones` gives one tone per bar and wins over it, so a slow check can stand out. `muted`, `accent`, `success`, `warning`, `danger` and `info` are the tones. A colour is not a cue for everyone, so say what the tone means in `label`.

<Demo name="sparkline/tones" />

## A note per bar

`hints` gives one note per bar, shown under the pointer by [TooltipHost](/ui/tooltip-host). The keyboard has `label` alone, which is why the notes are not tooltips on tab stops.

For axes, a legend and a tooltip a keyboard reaches, use [BarChart](/ui/bar-chart).

## Pressing and linking

`onSelect` makes every bar a button handing back its mark, and `href` returns an address for a mark (or `undefined`) that makes it a link, so a middle click or a crawler finds it; a plain click on a link still goes to `onSelect` when given. `onActive` hears the index the pointer or focus is on, `null` when it leaves, and `active` draws one as active, taking over from the pointer.
