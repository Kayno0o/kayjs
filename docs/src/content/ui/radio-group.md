---
description: A labelled list of radios to pick one option from, each with an optional description.
---

<Demo name="radio-group/basic" />

`value` is the option picked to start with, or `null` for none, and a group whose parent passes another follows it. `onChange` gets the picked option's own value, a number for a number option. An option carries a `label`, an optional `description` under it that screen readers read after the label, and may be `disabled`. Inside a form, the group posts the picked option under `name`, with no JavaScript. Use [Segmented](/ui/segmented) for a compact row of options.

## Disabled

`disabled` on the group disables every option, as on [Segmented](/ui/segmented). An option's own `disabled` still applies when the group's is false.

## Field error

Put the group in a [FormField](/ui/form-field) with `group` and the same `name`: the message refused for that field shows under the options, and each radio is marked invalid. The legend names the group, so leave `label` out there.

## Async change

Return a promise from `onChange` to hold the group busy until it settles. If the promise rejects or resolves to `false`, the previous pick is put back.

## Label

Without a FormField, `label` names the group for screen readers.
