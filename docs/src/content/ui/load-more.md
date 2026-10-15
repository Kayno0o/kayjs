---
description: The end of an infinite-scroll list that loads its pages by offset or cursor, with a loading row and a retry.
---

<Demo name="load-more/basic" />

`infiniteList(firstRows, { size, key, load })` owns the rows: pass it the first page the server rendered, and draw `list.rows()` however you like, in a `Table`, a `Masonry` or a plain `for`. `LoadMore(list={list})` goes after them: it draws the sentinel while there are more rows, a "Loading more…" status while a page is on its way, and nothing once the list has ended.

`load({ offset, last })` resolves to the next page. A source paging by offset skips `offset` rows, which counts every row fetched so far, duplicates included; one paging by cursor continues after `last`, the last row fetched. A page of fewer than `size` rows ends the list, and a list whose last page was exactly `size` ends on the one empty page after it. One page loads at a time, however often the sentinel fires.

`key` tells a row from another: a row a later page repeats because the list shifted meanwhile is dropped instead of shown twice. Leave it out for a source that cannot repeat a row.

## A failed page

A `load` that throws, or resolves `undefined` as an `attempt` does once it toasted, stops the list on an alert with a "Try again" button. No other page loads on scroll until it is pressed, and it asks for the same page again.

<Demo name="load-more/retry" />

`loadingLabel`, `failureLabel` and `retryLabel` replace the English texts; the loading row is a `status` and the failure an `alert`, so screen readers announce both. `margin` is WhenVisible's, 600 pixels by default.
