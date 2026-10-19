---
description: A row of mutually exclusive options, drawn as radio buttons.
---

<Demo name="segmented/basic" />

An option is `{ value, label, icon?, disabled? }`, the shape of every group: `icon` draws before the label and a `disabled` option cannot be picked.

## Numbers

A `value` may be a number, such as a page size or a count: `onChange` hears the number of the option picked, `0` included, so nothing is turned into text and back. The radios post it as text in a form, as any radio does.

## None picked

A `value` of `null` picks no option, for a moment when what shows matches none of them, such as a zoomed chart beside a period picker. Picking one, or the parent passing one, checks it again.

When `value` is typed to allow `null`, `onChange` is typed to hear `null` too, which is what a form reset sends a group that started with none picked. A group whose `value` is never `null` keeps `onChange: (value: Value) => ...`.

## Async change

Return a promise from `onChange` to hold the group busy until it settles. If the promise rejects or resolves to `false`, the previous option is put back, so a refused change never shows as made.

While the group is busy, a pick takes nothing: the radio is put back, and keyboard focus moves to the checked one with it, so focus and the check never disagree for a screen reader.

<Demo name="segmented/busy" />

## Label

`label` is required. It names the group for screen readers.
