---
description: A row of mutually exclusive options, drawn as radio buttons.
---

<Demo name="segmented/basic" />

## None picked

A `value` of `null` picks no option, for a moment when what shows matches none of them, such as a zoomed chart beside a period picker. Picking one, or the parent passing one, checks it again.

## Async change

Return a promise from `onChange` to hold the group busy until it settles. If the promise rejects or resolves to `false`, the previous option is put back, so a refused change never shows as made.

<Demo name="segmented/busy" />
