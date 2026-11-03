---
description: A time field posting a plain HH:MM value.
---

<Demo name="time-input/basic" />

The field is a native `input type="time"`, so the browser draws its own picker and a form posts `HH:MM` with no JavaScript. A `step` under a minute, in seconds, adds the seconds. `min` and `max` bound it, and without `value` it keeps what is typed. With `required`, `onChange` never hears an empty time: the box goes back to the last time once it is left empty, so a callback saving the time needs no guard.


## Size and invalid

`size` is `sm`, `md` or `lg`, `md` by default, and changes the box. `invalid` draws the line and the focus ring in the danger colour and sets `aria-invalid="true"`, for a refusal the page knows of. A FormField marks its control itself while it shows a message.
