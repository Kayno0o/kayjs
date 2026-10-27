---
description: A row of mutually exclusive options, drawn as radio buttons.
---

<Demo name="segmented/basic" />

An option is `{ value, label, icon?, disabled? }`, the shape of every group: `icon` draws before the label and a `disabled` option cannot be picked.

## Disabled

`disabled` on the group disables every option, as on [Toggle](/ui/toggle) and [Button](/ui/button). An option's own `disabled` still applies when the group's is false.

## Vertical

`orientation="vertical"` stacks the options in a column, for a short list beside a canvas or in a narrow panel. The options stay real radios of one group, so the arrow keys move between them in a column as in a row, and the group says `aria-orientation="vertical"`.

## Numbers

A `value` may be a number, such as a page size or a count: `onChange` hears the number of the option picked, `0` included, so nothing is turned into text and back. The radios post it as text in a form, as any radio does.

## None picked

A `value` of `null` picks no option, for a moment when what shows matches none of them, such as a zoomed chart beside a period picker. Picking one, or the parent passing one, checks it again.

To offer "none" as a choice of its own, give an option `value: null` when `value` is typed to allow `null`. It is checked while the group holds `null`, and picking it tells `onChange` `null`. In a form it posts an empty string, where a group with nothing checked posts nothing.

`kay check` fails a null option on a `value` that cannot be `null`, and one beside an option of `""`, which would post the same empty string. It reads the options' type, so it applies to literal or union values, and a component generic in its option value needs a cast on `options`.

When `value` is typed to allow `null`, `onChange` is typed to hear `null` too, which is what a form reset sends a group that started with none picked. A group whose `value` is never `null` keeps `onChange: (value: Value) => ...`.

## Async change

Return a promise from `onChange` to hold the group busy until it settles. If the promise rejects or resolves to `false`, the previous option is put back, so a refused change never shows as made.

While the group is busy, a pick takes nothing: the radio is put back, and keyboard focus moves to the checked one with it, so focus and the check never disagree for a screen reader.

<Demo name="segmented/busy" />

## Holding a query param

`param="period"` makes the group hold a query param of the page. A pick goes to the current page with the param set to the option and every other param kept, and the group stays busy until the page shows it. `paramDefault` is the value the page shows while the param is left out, so picking it leaves the param out. Pass `value` as the page read it.

```kay
Segmented(options={PERIODS} value={period} param="period" paramDefault="7d" label="Period")
```

An `onChange` of your own still runs first, and a `false` from it stops the move. The radios take `param` as their name, so inside a GET form with a button the group works without JavaScript. Alone, it needs JavaScript.

## Label

`label` is required. It names the group for screen readers.
