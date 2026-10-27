---
description: Horizontal bars ranking rows against the largest value.
---

<Demo name="bar-list/basic" />

Each row has a `key`, a `label` and a `value`; the largest value fills its track and the others scale against it. `display` replaces the number shown beside the label.

## Selecting a row

With `onSelect`, every row becomes a button handing back the row it was pressed on, its `key` on it. It has no `selected`, so the item is the payload; Table and TreeView, which have one, hand back what `selected` takes first and the item after.

<Demo name="bar-list/select" />

## Links

A row with an `href` draws its label as a link, so middle-click and a new tab work. A row that has an `href` is not a button, even when the list takes `onSelect`, so the two mix in one list.

<Demo name="bar-list/links" />

## Empty

With no rows, the list reads `emptyLabel` instead.

<Demo name="bar-list/empty" />
