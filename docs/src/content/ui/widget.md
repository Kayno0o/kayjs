---
description: A dashboard tile, a framed body under a head line of icon, title and actions.
---

<Demo name="widget/basic" />

`title` and `icon` fill the head line and `@actions` adds controls at its end.

## Empty

Set `empty` when the data behind the widget is empty. With an `@emptyState` block, the frame and head stay and the body shows the block; without one, the widget renders nothing at all. Before 1.89 these were `isEmpty` and `@empty`; they work until 1.92 and `kay check` renames them.

<Demo name="widget/empty" />
