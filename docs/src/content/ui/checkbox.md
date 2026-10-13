---
description: A labelled checkbox, native so it submits inside a form, with an optional hint and an indeterminate state.
---

<Demo name="checkbox/basic" />

## Controlled

`checked` sets the starting state and a box whose parent passes another value follows it. `onChange` receives the new state. `hint` adds a quieter note after the label. Without a `label`, pass `aria-label`. Use [Toggle](/ui/toggle) for a setting that applies as it is flipped.

## Indeterminate

`indeterminate` draws the box as neither ticked nor not, for a box standing over a partly ticked list. A click toggles it from `checked`, and it is drawn so again while the parent keeps `indeterminate`.

<Demo name="checkbox/indeterminate" />

## Async change

Return a promise from `onChange` to hold the box busy until it settles. If the promise rejects or resolves to `false`, the box goes back, so a refused change never shows as made.
