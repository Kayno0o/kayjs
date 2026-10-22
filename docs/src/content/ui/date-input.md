---
description: A date field with a keyboard-navigable calendar, posting a plain YYYY-MM-DD value.
---

<Demo name="date-input/basic" />

The field is a native `input type="date"`, so a form posts its value with no JavaScript. Once the island runs it adds a calendar button opening a popover in the page's locale, its weeks starting on the locale's first day, or on `firstDay` (0 for Sunday to 6 for Saturday).

## Value and bounds

`value` and `onChange` hold `YYYY-MM-DD`, or an empty string for no date. `min` and `max` bound the field and grey out the days of the calendar beyond them. Without `value` the field keeps what is picked, for a form posting it by its `name`.

<Demo name="date-input/bounds" />

## Keyboard

The calendar opens on the chosen day, or today. The arrows move by day and week, Home and End to the ends of the week, PageUp and PageDown by month and with Shift by year, Enter or Space picks the day and Escape closes it, focus going back to the button. The days are named in full for screen readers and the month is announced as it changes.

The button, month and Today labels read the `ui.dateInput.*` messages, or `openLabel`, `previousLabel`, `nextLabel` and `todayLabel`.
