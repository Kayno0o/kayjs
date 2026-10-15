---
description: A table of rows described by columns, with sortable headers and an empty state.
---

<Demo name="table/basic" />

## Sorting

Give a column a `sortValue` to make its header sortable: `true` sorts by the row's own value at `key`, a function sorts by what it returns. `defaultDirection` sets the first click's direction, and `onSort` reports each sort. With `serverSort`, the table only reflects the sort in its headers and your data source orders the rows.

## Empty

With a `@cell(row, column)` block, every column is drawn by it, except one marked `cell: false`, which shows its value as text. Once any column sets `cell: true`, the block draws only those columns. The `@empty` block is shown in place of the rows when there are none.

<Demo name="table/empty" />

## Selection

`selectable` puts a checkbox on each row and a select-all box above the rows, ticked, indeterminate or empty, reading `N selected` once rows are picked. It sits outside the table, so rows stacked as cards have it too. `selected` gives the keys to start from and `onSelect(keys)` hears every change. A key whose row left `rows` is dropped from the selection, which is what an infinite list's rows or a reload need; with a `filter`, select-all picks only the rows it shows.

The `@bulk(keys, clear)` block draws the page's bulk actions beside the count while something is picked, and `clear()` empties the selection. `selectAllLabel`, `selectedLabel(count)` and `selectRowLabel(row)` replace the texts, for another language.

<Demo name="table/selection" />
