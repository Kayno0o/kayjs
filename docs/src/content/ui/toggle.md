---
description: An on and off switch, a real checkbox that submits inside a form.
---

<Demo name="toggle/basic" />

## Controlled

`checked` sets the starting state and a switch whose parent passes another value follows it. `onChange` receives the new state. Without a `label`, pass `aria-label`.

`label` always names the control for screen readers, and `showLabel` chooses whether it is also written as text: on by default here, so `showLabel={false}` keeps it for screen readers alone. Every control with a `label` takes `showLabel`, as on [Segmented](/ui/segmented#label).

## Busy

Return a promise from `onChange` to hold the switch busy until it settles. If it rejects or resolves to `false`, the switch goes back to where it was.

<Demo name="toggle/busy" />

## Messages and refusals

`name` and `issue` show a message under the switch, as a [FormField](/ui/form-field) shows one, and mark it invalid; `invalid` marks it without a message. Inside a form posting to an action, a switch with no `onChange` starts from what a refused post sent.

## Required

`required` is the native attribute: the form cannot be submitted until the switch is on, with or without JavaScript.
