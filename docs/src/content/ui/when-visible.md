---
description: An infinite-scroll sentinel that calls a function when it comes into view.
---

<Demo name="when-visible/basic" />

Render `WhenVisible` after a list, only while there is more to load. `onVisible` is called when it comes into view and again whenever the list grows and leaves it there, so a list too short to scroll keeps filling. `margin` sets how many pixels before the end of the list the next rows load (600 by default).
