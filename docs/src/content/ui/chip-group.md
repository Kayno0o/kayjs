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

## Options from an action

`options` can be a promise of the options or a function returning them, such as an action. It is asked in the browser: the group is busy and shows `loadingLabel` meanwhile, and `failureLabel` with a `retryLabel` button if it fails; a promise cannot be asked again, so it has no button. `onLoad(options, query)` and `onError({ error, query })` follow the answer. Without a `value`, the first option that is not disabled is picked once they arrive.

## Async change

Return a promise from `onChange` to hold the group busy until it settles. If the promise rejects or resolves to `false`, the previous pick is put back, so a refused change never shows as made.

## Label

`label` is required. It names the group for screen readers. `showLabel` also writes it above the chips and names the group by it, as on [Segmented](/ui/segmented#label).

## Drawing an option

`@option(option)` draws each option in place of its label, and its icon if it has one, as in Combobox: an avatar with a name, a price, a colour dot. The input stays, with its checked and disabled state, and the option's `label` still names it for screen readers.

## Required

`required` asks for at least one chip to be picked. Each box gets `aria-required="true"`, and the first enabled box refuses the form's submit with `requiredLabel` (`Pick at least one`) while none is picked, since the browser has no attribute for one of several checkboxes. That needs JavaScript: with none, nothing in the browser asks for a pick, and the action's schema is what refuses a post with no chip.
