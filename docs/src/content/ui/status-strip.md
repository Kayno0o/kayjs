---
description: A row of coloured cells for the state over time, read as one sentence.
---

<Demo name="status-strip/basic" />

`cells` is one tone per cell, in the order shown: `success`, `warning`, `danger`, `info`, `accent` or `muted`. A cell left `undefined` is drawn as a dashed outline, apart from the solid `muted` cell, such as a period before the check existed. The cells share the width of the strip, so any number fits, down to a phone's width. `--strip-height` sets the height, `1.5rem` by default.

`label` is the whole strip in one sentence, such as how long it was up and when it went down. A screen reader hears it once instead of a tooltip on each cell, and colour is not the only signal, since the sentence says the states.

`hints` gives one note per cell, shown under the pointer by [TooltipHost](/ui/tooltip-host) and not reachable by keyboard.
