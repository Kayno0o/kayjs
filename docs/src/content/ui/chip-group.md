---
description: A row of chips to pick several options from, drawn over real checkboxes.
---

<Demo name="chip-group/basic" />

`value` lists the options picked to start with, and a group whose parent passes others follows them. `onChange` gets every picked option, in the order of `options`. An option may carry an `icon` and be `disabled`. Inside a form, the group posts each picked option under `name`. Use [Segmented](/ui/segmented) when only one option may be picked.

## Numbers

A `value` may be numbers, such as weekdays from `Date.getDay()`: `onChange` hears the numbers of the options picked, so nothing is turned into text and back. The checkboxes post them as text in a form, as any checkbox does.

<Demo name="chip-group/numbers" />

## Disabled

`disabled` greys out every chip, as on [Toggle](/ui/toggle) and [Button](/ui/button). An option's own `disabled` still applies when the group's is false.

## Async change

Return a promise from `onChange` to hold the group busy until it settles. If the promise rejects or resolves to `false`, the previous pick is put back, so a refused change never shows as made.

## Label

`label` is required. It names the group for screen readers.
