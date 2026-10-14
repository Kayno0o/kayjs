---
description: Two number boxes for a range, each bound open when left empty.
---

<Demo name="range-input/basic" />

## Open bounds

`value` is a `[from, to]` pair where `null` leaves a bound open. `min`, `max` and `step` bound the numbers and show as the empty boxes' placeholders, `unit` is written after them. Each box is named `{label} from` and `{label} to`, or `fromLabel` and `toLabel`.

## Filtering

`onChange` runs once a box is committed, on blur or Enter, and only when the range changed. A reversed pair is put back in order, so a filter can use it as is.

<Demo name="range-input/prices" />
