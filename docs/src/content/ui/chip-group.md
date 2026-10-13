---
description: A row of chips to pick several options from, drawn over real checkboxes.
---

<Demo name="chip-group/basic" />

`value` lists the options picked to start with, and a group whose parent passes others follows them. `onChange` gets every picked option, in the order of `options`. An option may carry an `icon` and be `disabled`. Inside a form, the group posts each picked option under `name`. Use [Segmented](/ui/segmented) when only one option may be picked.

## Async change

Return a promise from `onChange` to hold the group busy until it settles. If the promise rejects or resolves to `false`, the previous pick is put back, so a refused change never shows as made.
