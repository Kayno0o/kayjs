---
description: Horizontal bars ranking rows against the largest value.
---

<Demo name="bar-list/basic" />

Each row has a `key`, a `label` and a `value`; the largest value fills its track and the others scale against it. `display` replaces the number shown beside the label.

## Selecting a row

With `onSelect`, every row becomes a button handing back the row it was pressed on.

<Demo name="bar-list/select" />

## Empty

With no rows, the list reads `emptyLabel` instead. `empty` is its deprecated name.

<Demo name="bar-list/empty" />
