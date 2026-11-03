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

## Opened by the app

`open` shows the calendar when your code sets it, and `onOpenChange(open)` is called whenever it shows or hides: the button, a click outside, Escape or a pick. When you drive `open`, set your own value back in `onOpenChange`. `DateRangeInput` takes `onOpenChange(open, box)` too, `box` being `'from'` or `'to'`.

## Closed days and a day cell

`isDisabled(iso)` closes single days, such as weekends or booked ones: the day is a disabled button, the arrow keys skip it (a week at a time for up and down), and a typed date it refuses is flagged invalid with `unavailableLabel` and not reported to `onChange`, as a date outside `min` and `max` is flagged by the browser. `min` and `max` still bound the calendar.

The `day(iso, state)` block draws the inside of a day's button in place of its number, for a price or a dot under it. Write the number in it yourself; the button, its `aria-label` and the selection stay, and `state` says whether the day is `selected`, `today`, `outside` the month or `disabled`.

```kay
---
import DateInput from '@kaynooo/kayjs-ui/date-input.kay'

const closed = new Set(['2026-12-24', '2026-12-25'])
const prices: Record<string, number> = { '2026-12-23': 90 }
---
DateInput(aria-label="Arrival" name="arrival" isDisabled={iso => closed.has(iso)} onMonthChange={month => console.log(month)})
  @day(iso, state)
    span {Number(iso.slice(8))}
    if !state.disabled
      small {prices[iso] ?? 60}
```

`onMonthChange(month)` hears the month on show as `YYYY-MM`, on opening and on each move, so an app can load that month's availability. `DateRangeInput` takes the same three, `onMonthChange(month, box)` with the box.


## Size and invalid

`size` is `sm`, `md` or `lg`, `md` by default, and changes the padding and the type of the box. `invalid` draws the line and the focus ring in the danger colour and sets `aria-invalid="true"`, for a refusal the page knows of. A FormField marks its control itself while it shows a message.
