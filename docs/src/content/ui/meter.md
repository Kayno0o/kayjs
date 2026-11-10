---
description: A bar showing a level, such as a disk or quota usage, with its value as text and colors by threshold.
---

<Demo name="meter/basic" />

`value` is held between 0 and `max`, 100 by default, so it reads as a percentage. Screen readers hear `value` out of `max`: a meter at 3 of 10 reads 3, not 30. `label` names the meter for screen readers.

## The value as text

`formatValue(value, max)` words the value, a function such as `(value, max) => value + ' of ' + max + ' seats'`. Screen readers hear it as `aria-valuetext`, and `showValue` draws it under the bar, `value / max` when there is no `formatValue`. A `@reading(text, value, max)` block draws the text in your own markup and shows without `showValue`. Either of them wraps the bar in a `field` part.

A function or a block with parameters makes the Meter an island on the page that passes it, so write `--- island` there.

<Demo name="meter/value" />

## Colors by threshold

`thresholds={[{ upTo: 70, tone: 'success' }, { upTo: 90, tone: 'warning' }, { upTo: Infinity, tone: 'danger' }]}` colors the fill by the first step whose `upTo` is at least the value, in any order; a value past every step keeps the accent. The fill carries `data-tone` for your CSS. `class={{ fill: 'bg-warning' }}` styles the fill alone and replaces its color, for a rule of your own. The old `fillClass` prop still works and goes in 2.0.0.

<Demo name="meter/thresholds" />

## Size

`size` is `sm`, `md` (default) or `lg`, the height of the bar. [Progress](/ui/progress) takes the same `size`, `formatValue`, `thresholds`, `showValue` and `@reading`.
