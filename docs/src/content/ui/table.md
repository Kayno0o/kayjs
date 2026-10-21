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

The `@bulk(keys, clear)` block draws the page's bulk actions beside the count while something is picked, and `clear()` empties the selection. The keys have the type of the `rowKey` field, so a table keyed by a string field hands a `string[]` to an action with no conversion. `selectAllLabel`, `selectedLabel(count)` and `selectRowLabel(row)` replace the texts, for another language.

<Demo name="table/selection" />

## Row key

`rowKey` is required. It returns a string or a number that names a row across updates, and a selection is kept by it.

## Filtering

A `filter` adds a search box. `filterLabel` names it, `Filter` by default, and `filterPlaceholder` fills it. `filterParam` keeps the typed text in the page's URL under that query parameter, so a reload or a shared link filters the same. Without it the text stays on the page.

`countLabel(count)` words how many rows the filter keeps, as screen readers hear it. `noMatch` is shown in place of the rows when the filter hides every one, and `empty` otherwise.

## Exporting

`exportable` adds an Export CSV button that downloads the rows as they are on screen, with the filter and the sort applied. Each column writes the row's own value at its `key`, headers first, and a text a spreadsheet would run as a formula (starting with `=`, `+`, `-`, `@`, a tab or a carriage return) gets a leading apostrophe. `exportLabel` and `exportName` replace the button's text and the file's name.

<Demo name="table/export" />

When the page holds only a part of the rows, give `exportable` an address: the button links it with the sort as `sort` and `direction` and the typed filter text under `filterParam` (`q` without one), and your endpoint answers with `toCsv(rows, columns)`, which the package exports.

## Many rows

`virtual` draws only the rows in view, with room above and below standing for the others, so ten thousand rows and more stay light. The table scrolls in a box of its own, 70vh tall unless `--kui-table-height` says otherwise, with its headers kept on top. Rows are measured as they draw, stacked cards included, and the table tells screen readers its real row count and each row's position.

<Demo name="table/virtual" />

The choice is made once, when the table is made, and the server draws the first screenful only: the rest shows once the page has loaded its script. Name the scroll box with an `aria-label`. The box takes the focus to scroll by keyboard. Find-in-page only sees the rows drawn, and a focused control in a row that scrolls out of view loses its focus, so pair a long table with `filter`.

## Narrow screens

Below 30rem of width, `narrow` is `stack` by default: rows stack as cards labelled by their headers. Set `narrow="scroll"` to scroll the table sideways instead.
