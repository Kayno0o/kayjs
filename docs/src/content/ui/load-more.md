---
description: The end of an infinite-scroll list that loads its pages by offset or cursor, with a loading row and a retry.
---

<Demo name="load-more/basic" />

`infiniteList(firstRows, { pageSize, key, load })` owns the rows: pass it the first page the server rendered, and draw `list.rows()` however you like, in a `Table`, a `Masonry` or a plain `for`. `LoadMore(list={list})` goes after them: it draws the sentinel while there are more rows, a "Loading more…" status while a page is on its way, and nothing once the list has ended.

`load({ offset, last })` resolves to the next page. A source paging by offset skips `offset` rows, which counts every row fetched so far, duplicates included; one paging by cursor continues after `last`, the last row fetched. A page of fewer than `size` rows ends the list, and a list whose last page was exactly `size` ends on the one empty page after it. One page loads at a time, however often the sentinel fires.

A `Table` takes the list as `list={list}` in place of `rows`: it draws `list.rows()`, puts `LoadMore` after them, and sorts on the server. A header click calls `list.sortBy(sort)`, which starts the list over from offset 0: `load` receives the sort as `sort` beside `offset` and `last`, and the rows on screen stay until the first page in the new order lands.

The list also starts over on mount when the table's sort, from `sort` or the URL, differs from the `sort` the list was made with, so give both the same one to keep the first page. A sort drops the picked rows that are not in the new first page, as a row leaving the table always does.

A `filter` search box filters on the server too. The typed text reaches `load` as `filter.text` once typing pauses, and the list starts over from offset 0 as it does for a sort. The rows already loaded are not matched again, so `load` has to narrow its pages itself. `filter` or `filterParam` shows the box, and `filterParam` keeps the text in the URL.

`fields` adds more inputs beside the box: `fields={[{ key: 'origin', label: 'Origin', options }, { key: 'tag', label: 'Tag' }]}`. A field with `options` is a select, one without is a text box. The value reaches `load` as `filter.fields.origin` (empty fields are left out) and stays in the URL under `key`. A key the table already writes in the URL, such as `sort`, `direction` or the search's own, throws as the table is made.

A sort and a filter changed together load one page, and a sort clicked while typed text waits for its pause loads at once, the text with it.

`list.filterBy({ text, fields })` does the same from code. The list begins with the `filter` option's value, and loads again on mount when the URL holds another.

Mark the columns to sort by with a `sortValue` (`numeric` columns have one).

The table's `sort` and the URL's `sortParam` sort reach the list too, and a sort restarts it, so a selected row outside the first page leaves the selection. `infiniteList`'s `sort` option names the order the first page is already in.

`key` tells a row from another: a row a later page repeats because the list shifted meanwhile is dropped instead of shown twice. Leave it out for a source that cannot repeat a row.

`list.patch(id, change)` updates one loaded row, the one `key` reads as `id`, with the fields to merge over it or a function of the row returning it. An action that toggles a row and answers it as the server now holds it feeds the list with `list.patch(row.id, answer)`, and the other rows stay as they are. It answers whether a row matched, and an `undefined` change, such as a failed `attempt`'s, does nothing.

## Over an action

In an island marked `persist`, the list follows the props the next page gives it. An action source whose `input` is a function reading them starts the list over from the first page that input asks for. Pass the first rows as a function, `infiniteList(() => rows, ...)`, to start the list over from new rows when the `rows` prop changes. A list made from a plain array and an `input` that reads no prop keeps its rows: give the island another `persist` value for each input.

An action loading the pages replaces `load`: `infiniteList(first, { pageSize, key, action: listPeople, input: { team }, failure: 'Could not load people.' })`. Each page calls it with `{ refresh: false }` through `attempt`, so a failed call toasts `failure` and fails the page. `input` holds the call's other fields; `offset` and `limit` are added from the page.

For a cursor or a sort, `input` can be a function of where the page starts, such as `at => at.last && { before: at.last.id }` or `at => ({ q: at.filter.text })`. It answers the call with `offset` and `limit` added under what it names, and `undefined` loads an empty page, which is what a list with no row to continue after should do. When the answer is not an array of rows, `rows: answer => answer.items` reads them out.

On the server, `pageFields()` gives the action its `offset` and `limit` fields with their bounds named once, and `pageOf(rows, input)` cuts a list held whole to a page and answers `{ rows, total }`. The action and the page that renders the first rows both call it, so neither slices by hand.

## A failed page

A `load` that throws, or resolves `undefined` as an `attempt` does once it toasted, stops the list on an alert with a "Try again" button. No other page loads on scroll until it is pressed, and it asks for the same page again.

<Demo name="load-more/retry" />

`button` swaps the sentinel for a "Load more" button, `moreLabel` its text, for a page whose footer must stay within reach. Once a page adds rows, a status only screen readers hear says how many ("3 more loaded"); `loadedLabel` is a function of that count replacing the text.

`loadingLabel`, `failureLabel` and `retryLabel` replace the English texts; the loading row is a `status` and the failure an `alert`, so screen readers announce both. `margin` is WhenVisible's, 600 pixels by default.
