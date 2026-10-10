---
description: A row of mutually exclusive options, drawn as radio buttons.
---

<Demo name="segmented/basic" />

## Async change

Return a promise from `onChange` to hold the group busy until it settles. If the promise rejects or resolves to `false`, the previous option is put back, so a refused change never shows as made.

<Demo name="segmented/busy" />
