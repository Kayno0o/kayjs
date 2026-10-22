---
description: A time field posting a plain HH:MM value.
---

<Demo name="time-input/basic" />

The field is a native `input type="time"`, so the browser draws its own picker and a form posts `HH:MM` with no JavaScript. A `step` under a minute, in seconds, adds the seconds. `min` and `max` bound it, and without `value` it keeps what is typed.
