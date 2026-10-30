---
description: A bar showing a percentage, such as a disk or quota usage.
---

<Demo name="meter/basic" />

## Colors by threshold

`value` is held between 0 and `max`, 100 by default, so it reads as a percentage. `class={{ fill: 'bg-warning' }}` styles the fill alone and replaces its accent, so a page can pick a color from the value. The old `fillClass` prop still works and goes in 2.0.0.

<Demo name="meter/thresholds" />

## Label

`label` names the meter for screen readers.
