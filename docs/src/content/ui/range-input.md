---
description: Two number boxes for a range, each bound open when left empty.
---

<Demo name="range-input/basic" />

## Open bounds

`value` is a `[from, to]` pair where `null` leaves a bound open. `min`, `max` and `step` bound the numbers and show as the empty boxes' placeholders, `unit` is written after them. Each box is named `{label} from` and `{label} to`, or `fromLabel` and `toLabel`.

`showLabel` writes `label` above the boxes and names it by that text, and the `field` part wraps the two with the label as `heading`; `label` names it for screen readers alone otherwise. Every control with a `label` takes `showLabel`, as on [Segmented](/ui/segmented#label).

## Filtering

`onChange` runs once a box is committed, on blur or Enter, and only when the range changed. A reversed pair is put back in order, so a filter can use it as is.

<Demo name="range-input/prices" />

To read the two boxes of a plain form post on the server, `rangeFrom(low, high)` from kayjs-ui takes both strings and gives the same `[from, to]` pair: an empty box is `null`, and a reversed pair is put back in order.


## Size and invalid

`size` is `sm`, `md` or `lg`, `md` by default, and changes both boxes. `invalid` draws the line and the focus ring in the danger colour and sets `aria-invalid="true"`, for a refusal the page knows of. A FormField marks its control itself while it shows a message.
