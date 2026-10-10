---
description: A table of rows described by columns, with sortable headers and an empty state.
---

<Demo name="table/basic" />

## Sorting

Give a column a `sortValue` to make its header sortable: `true` sorts by the row's own value at `key`, a function sorts by what it returns. `defaultDirection` sets the first click's direction, and `onSort` reports each sort. With `serverSort`, the table only reflects the sort in its headers and your data source orders the rows.

## Empty

Columns marked `cell: true` are drawn by the `@cell(row, column)` block. The `@empty` block is shown in place of the rows when there are none.

<Demo name="table/empty" />
