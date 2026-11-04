---
description: A long list drawing only the rows in view, however tall each one is.
---

<Demo name="virtual-list/basic" />

`VirtualList(items={rows} label="Rows")` with an `@item(row, index)` block draws the rows in view and, above and below them, room standing for the others, so a list of ten thousand rows costs what a screenful does. It scrolls in a box of its own, 70vh tall unless the app gives `.kui-virtual-list` another height. For a table, use `Table`'s `virtual`.

## Heights

A row starts at `estimate` pixels (48) and takes the height it measures once drawn, so rows of any height work. Give `estimate` near the rows' own and the scroll bar moves less as they are measured. `overscan` is how many rows are drawn beyond the visible ones on each side, 4 by default.

`itemKey` names a row across updates, so a measured height stays with it when the list shifts; without it the row's index is its key.

A row's height is its border box, so give its content padding or a gap rather than a margin. The server draws the first screenful, so the rest shows once the page has loaded its script.

## Keyboard, screen readers and find

The list is `role="list"` named by `label`, which is required, and each row a `listitem` with its position among all, so a screen reader hears "3 of 10000". The box takes the focus to scroll by keyboard: arrows, Page Up and Down, Home and End.

Find-in-page only sees the rows drawn, and a focused control in a row that scrolls out of view loses its focus. Give a long list a filter to find a row by.

## From a function or a promise

`items` also takes a function returning the items or a promise of them. An array is drawn by the server; a function is called in the browser only and a promise's answer lands there, the server drawing `skeletonItems` (5) skeletons for both. A rejection keeps the items shown beside a `failureLabel` with a retry.

`onLoad` and `onError` hear each answer, `busy` shows the skeleton for items the page loads itself. `itemHref(item, index)` and `onItemClick(item, index, event)` make each item a link or a button, a stretched anchor named by `itemLabel` over it with the item's own links and buttons above. The link covers the item, so its text cannot be selected with the mouse and a `tooltip` on the item's own content does not show; put them on a control.

## Loaded page by page

It takes `list`, an `infiniteList`, in place of the array.`LoadMore` follows the rows inside the box, so the next page loads as the reader nears the end, and a failed page shows its alert with a retry. See [Infinite lists](/ui/load-more).
