---
description: An infinite-scroll sentinel that calls a function when it comes into view.
---

<Demo name="when-visible/basic" />

Render `WhenVisible` after a list, only while there is more to load. `onVisible` is called when it comes into view and again whenever the list grows and leaves it there, so a list too short to scroll keeps filling.

## Loading from a source

`onVisible` may return a promise: it is not called again before it settles. Keep the sentinel rendered only while there are more rows, so a list that has ended is left alone.

<Demo name="when-visible/async" />

## Loading ahead

`margin` sets how many pixels before the end of the list the next rows load, 600 by default. Lower it to load only when the end is reached, here with `margin={0}`.

<Demo name="when-visible/margin" />
