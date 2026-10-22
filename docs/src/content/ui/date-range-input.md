---
description: Two date fields for a range, each bound open when empty.
---

<Demo name="date-range-input/basic" />

`value` is a `[from, to]` pair of `YYYY-MM-DD` strings where `null` leaves a bound open. Each field is a DateInput, named `{label} from` and `{label} to`, or `fromLabel` and `toLabel`; `min`, `max` and `firstDay` reach both.

`onChange` runs when a date is set and only when the range changed. A reversed pair is put back in order in both fields, so a filter can use it as is.

To post the range in a plain form, give `fromName` and `toName`, and read the two strings on the server with `dateRangeFrom(from, to)` from kayjs-ui: an empty or invalid date is `null`, and a reversed pair is put back in order.
