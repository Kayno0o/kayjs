---
description: A date and time field showing the visitor's own clock and posting an instant with its offset.
---

<Demo name="date-time-input/basic" />

The field is a native `input type="datetime-local"`, which carries no zone, so a server cannot tell which instant the visitor meant. Once the island runs, the field posts the instant with the visitor's offset under its `name`, as `2026-10-21T09:30:00+02:00`, and `s.Date()` reads that right. `value` and `onChange` hold the same text, or an empty string for none.

## Value and bounds

`value` is any ISO instant, with an offset or `Z`, and the box shows it on the visitor's clock. `min` and `max` are instants too, as text or a `Date`, and bound the box on that clock. Without `value` the field keeps what is typed, for a form posting it by its `name`.

The server cannot know the visitor's zone, so it draws the box empty. Without JavaScript the box posts the local text it holds, with no offset, which `s.Date()` refuses.
