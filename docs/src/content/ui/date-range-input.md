---
description: Two date fields for a range, each bound open when empty.
---

<Demo name="date-range-input/basic" />

`value` is a `[from, to]` pair of `YYYY-MM-DD` strings where `null` leaves a bound open. Each field is a DateInput, named `{label} from` and `{label} to`, or `fromLabel` and `toLabel`; `min`, `max` and `firstDay` reach both.

`showLabel` writes `label` above the boxes and names it by that text, and the `field` part wraps the two with the label as `heading`; `label` names it for screen readers alone otherwise. Every control with a `label` takes `showLabel`, as on [Segmented](/ui/segmented#label).

`onChange` runs when a date is set and only when the range changed. A reversed pair is put back in order in both fields, so a filter can use it as is.

To post the range in a plain form, give `fromName` and `toName`, and read the two strings on the server with `dateRangeFrom(from, to)` from kayjs-ui: an empty or invalid date is `null`, and a reversed pair is put back in order.


## Size and invalid

`size` is `sm`, `md` or `lg`, `md` by default, and changes both boxes. `invalid` draws the line and the focus ring in the danger colour and sets `aria-invalid="true"`, for a refusal the page knows of. A FormField marks its control itself while it shows a message.
