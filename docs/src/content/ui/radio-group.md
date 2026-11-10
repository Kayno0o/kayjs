---
description: A labelled list of radios to pick one option from, each with an optional description.
---

<Demo name="radio-group/basic" />

`value` is the option picked to start with, or `null` for none, and a group whose parent passes another follows it. `onChange` gets the picked option's own value, a number for a number option. An option carries a `label`, an optional `description` under it that screen readers read after the label, and may be `disabled`. Inside a form, the group posts the picked option under `name`, with no JavaScript.

When `value` is typed to allow `null`, an option may carry `value: null` for a "none" choice of its own. It is checked while the group holds `null`, tells `onChange` `null` when picked, and posts an empty string in a form.

`kay check` fails a null option on a `value` that cannot be `null`, and one beside an option of `""`, which would post the same empty string. It reads the options' type, so it applies to literal or union values, and a component generic in its option value needs a cast on `options`.

Use [Segmented](/ui/segmented) for a compact row of options.

## Disabled

`disabled` on the group disables every option, as on [Segmented](/ui/segmented). An option's own `disabled` still applies when the group's is false.

## Field error

Put the group in a [FormField](/ui/form-field) with `group` and the same `name`: the message refused for that field shows under the options, and each radio is marked invalid. The legend names the group, so leave `label` out there.

## Options from an action

`options` can be a promise of the options or a function returning them, such as an action. It is asked in the browser: the group is busy and shows `loadingLabel` meanwhile, and `failureLabel` with a `retryLabel` button if it fails; a promise cannot be asked again, so it has no button. `onLoad(options, query)` and `onError({ error, query })` follow the answer. Without a `value`, the first option that is not disabled is picked once they arrive.

## Async change

Return a promise from `onChange` to hold the group busy until it settles. If the promise rejects or resolves to `false`, the previous pick is put back.

## Label

Without a FormField, `label` names the group for screen readers.

## Drawing an option

`@option(option)` draws each option in place of its label, and its icon if it has one, as in Combobox: an avatar with a name, a price, a colour dot. The input stays, with its checked and disabled state, and the option's `label` still names it for screen readers.

## Required

`required` asks for one of the options to be picked. Each radio gets the native `required`, so the browser's validation and a post with no JavaScript know it, and the group gets `aria-required="true"`. A [FormField](/ui/form-field) with `required` around a RadioGroup marks the same in the browser.
