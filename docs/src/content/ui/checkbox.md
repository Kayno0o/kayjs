---
description: A labelled checkbox, native so it submits inside a form, with an optional hint and an indeterminate state.
---

<Demo name="checkbox/basic" />

## Controlled

`checked` sets the starting state and a box whose parent passes another value follows it. `onChange` receives the new state. `hint` adds a quieter note after the label. Without a `label`, pass `aria-label`. Use [Toggle](/ui/toggle) for a setting that applies as it is flipped.

`label` always names the control for screen readers, and `showLabel` chooses whether it is also written as text: on by default here, so `showLabel={false}` keeps it for screen readers alone. Every control with a `label` takes `showLabel`, as on [Segmented](/ui/segmented#label).

## Indeterminate

`indeterminate` draws the box as neither ticked nor not, for a box standing over a partly ticked list. A click toggles it from `checked`, and it is drawn so again while the parent keeps `indeterminate`.

<Demo name="checkbox/indeterminate" />

## Async change

Return a promise from `onChange` to hold the box busy until it settles. If the promise rejects or resolves to `false`, the box goes back, so a refused change never shows as made.

## Messages and refusals

`name` and `issue` show a message under the box, as a [FormField](/ui/form-field) shows one: inside a FormDialog the message its call was refused with for `name` appears there, and `issue` takes a message of the page's own, such as `add.error('terms')` after a plain form post. A message marks the box invalid, and `invalid` marks it without one.

Inside a form posting to an action, a box with no `onChange` starts from what a refused post sent, so a page working without JavaScript shows the choice again.

## Required

`required` is the native attribute: the form cannot be submitted until the box is ticked, with or without JavaScript. A [FormField](/ui/form-field) with `required` around a single checkbox sets it too.
