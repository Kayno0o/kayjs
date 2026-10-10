---
description: A list and a detail pane side by side, which stack into one pane at a time on a narrow screen.
---

<Demo name="split-layout/basic" />

The `@list` and `@detail` blocks fill the two panes. Below the `md` breakpoint only one is shown, and `detailOpen` says whether the detail takes the list's place. `@listHead` and `@detailHead` add a head line above each pane, and `@sidebar` a navigation column.

## Resizable list

`resizableList` adds a handle on the list's right edge, dragged or moved with the arrow keys. `listWidthKey` keeps the width in `localStorage` from one visit to the next.

<Demo name="split-layout/resizable" />
