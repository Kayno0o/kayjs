---
description: An on and off switch, a real checkbox that submits inside a form.
---

<Demo name="toggle/basic" />

## Controlled

`checked` sets the starting state and a switch whose parent passes another value follows it. `onChange` receives the new state. Without a `label`, pass `aria-label`.

## Busy

Return a promise from `onChange` to hold the switch busy until it settles. If it rejects or resolves to `false`, the switch goes back to where it was.

<Demo name="toggle/busy" />
