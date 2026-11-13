# kayjs-ui: Table

## Common tasks

### Table

```ts
import type { Column } from '@kaynooo/kayjs-ui'

const columns: Column<Post>[] = [
  { key: 'title', header: 'Title', sortValue: true },
  { key: 'views', header: 'Views', numeric: true },
  { key: 'author', header: 'Author', cell: false },
]
```

```kay
Table(columns={columns} rows={posts} rowKey="id" filter={['title', 'author']} filterParam="q")
  @cell(post, column)
    if column.key === 'title'
      a(href={`/posts/${post.id}`}) {post.title}
    else
      | {post.views.toLocaleString()}
  @empty
    EmptyState(title="No posts yet")
  @noMatch
    EmptyState(title="No post matches")
```

## What a page ships

A Table in an island ships only the features the project's `.kay` files write on it. With no `selectable`, `expandable`, `exportable`, `columnToggle`, `virtual`, `filter`, `fields`, `filterParam`, `sortParam`, `list`, `pageSize`, `rowHref` or `onRowClick` at any call site, the code behind that prop stays out of the island's chunks: a table with only `filter` and `pageSize` loads about 22 KB less than one with every feature.

Nothing is declared. kay reads the props at each `<Table>` call of the project's `.kay` files (not `node_modules`), takes the union, and builds one variant of the Table that every island loads, so two islands share it.

A BarChart does the same: with no `marks`, `onMark`, `href`, `onSelect` or `tooltip` at any call site, its events, link and button columns and tooltip stay out of the island, about 8 KB less.

A call with a spread (`Table({...props})`), or a Table read anywhere but as a tag (`const T = Table`, passed as a value), asks for every feature.

The server render, `kay check` and a plain `bun test` use the full Table. The `kay dev` client and `mountComponent` build the browser variant, so a test mounting a page sees what the island ships.

Only an import written as `import Table from '@kaynooo/kayjs-ui/table.kay'` (or a relative one) is specialized.

## Reference

- With a `@cell(row, column)` block, every column shows what it draws, but one with `cell: false`, which shows the row's value at `key` as text, as every column does without the block. A table where any column sets `cell: true` draws only those through the block.
- `numeric: true` marks a count or an amount: aligned to the end, its digits in columns, sorted by its own value and largest first, each overridable by `align`, `sortValue` and `defaultDirection`.
- A column with `sortValue` sorts when its header is clicked. `true` sorts by the row's value at `key`; a function sorts by what it returns.
- The first click sorts in `defaultDirection`, `desc` unless set, and the next click flips it. `sort` gives the sort to start from.
- `sortable={false}` makes no header sortable, `numeric` columns included: for rows loaded page by page, which a header click would sort alone.
- `list={people}` (from `infiniteList`, see LoadMore) instead of `rows`: the table draws the loaded rows with `LoadMore` after them and sorts on the server (and filters there: `filter` and `fields`, see [Infinite lists](infinite-list.md)), a header click reloading the list from offset 0 with the sort passed to its `load`. One of `rows` and `list` is required, and `kay check` fails a Table with neither or both. The list loads again from offset 0 when the table's sort differs from the `sort` its `infiniteList` was made with, on mount included, so give both the same one to keep the first page.
- `serverSort` leaves the rows in the order they came. The headers show the sort, and `onSort(sort)` lets the page fetch the rows sorted that way, from a load or an action.
- With `sortValue: true`, dates sort by time, booleans as 0 and 1, and a missing value sorts last in either direction.
- `rowKey` is a field of the row or a function of it, and tells rows apart across a sort.
- `filter` shows a search box above the rows, `filterLabel` (`Filter`) naming it, and keeps the rows where a value it reads holds the typed text, case and surrounding spaces ignored: the fields it names, or what a function of the row returns, `filter={post => [post.title, post.author.name]}`. `filterParam="q"` keeps the text in the page's URL as `?q=`, which the server reads too, so a reload or a shared link renders filtered. `sortParam="sort"` does the same for the sort a header click picks, the column's key as `?sort=` and its direction as `?direction=` (`<name>Direction` for any other name), restored on load, reload and back and forward and winning over `sort`; a click replaces the history entry, and `exportable` with an address still sends the sort as `sort` and `direction`. Screen readers hear how many rows the typed text keeps from a status region, worded by `countLabel(count)`. `@noMatch` shows when the filter hides every row, `@empty` when there are none.
- Narrower than 30rem, its own width and not the screen's, so a table in a sidebar does it too, each row stacks as a card: a line per cell, its column `header` beside it as the label, the labels as wide as the longest up to 40% of the card, every value starting right after its label whatever its column's `align`, which a wide table keeps, and only the sortable headers kept, as a row of sort buttons. A column with an empty `header` spans the card's width. `narrow="scroll"` keeps the table whole and scrolls it sideways instead. A stacking table's wrapper is a size container, so it takes its width from its parent and never from its content: in an `auto`-sized grid column it collapses, where `narrow="scroll"` does not.
- `onSelectedChange` (Table, TreeView, Timeline) hands a value of the shape `selected` takes first, so `onSelectedChange={folder.set}` round-trips, then the item or items; `onSelect` (BarList, the charts, Steps, Menu) hands back the item pressed: [the rule](open-state-and-sources.md).
- `selectable` puts a checkbox on each row and, above the rows, a select-all box (ticked, indeterminate or not) with `N selected` beside it, a status screen readers hear, outside the table. `selected={keys}` gives the keys to start from (a new list from the parent is followed) and `onSelectedChange(keys, rows)` hears every change, the keys as `selected` takes them and the rows they stand for, both in the rows' order. A key whose row is no longer in `rows` leaves the selection, `onSelectedChange` told, but `selected` is held while the first rows are still loading or failed; select-all acts on the rows the filter shows and leaves hidden ones as they are. The keys have the type of the `rowKey` result, so a `string[]` parameter takes them with no cast. `@bulk(keys, clear)` draws the page's bulk actions beside the count while something is picked, `clear()` emptying the selection: `Table(columns={columns} rows={sites} rowKey="name" selectable)` then `@bulk(names, clear)` holding `Button(label="Disable" onClick={async () => { await disable(names); clear() }})`. Row boxes are named `Select <first column's text>`; `selectAllLabel` (`Select all`, also the column's header for screen readers), `selectedLabel(count)` (`{n} selected`) and `selectRowLabel(row)` replace the words.
- `expandable` puts a toggle (`aria-expanded`, `aria-controls`, named `Details of <first column's text>`, `expandLabel(row)` replaces it) on each row opening the `@detail(row)` block in a full-width row under it, or under its card when stacked; rows start closed. `expanded={keys}` gives the keys to start open (a new list from the parent is followed) and `onOpenChange(key, open)` hears each toggle. Not combinable with `virtual`: `Table(columns={columns} rows={moons} rowKey="id" expandable)` then `@detail(moon)` holding `p {moon.orbit}`.
- `exportable` puts an `Export CSV` button above the rows (`exportLabel` words it, `exportName` is the file, `table.csv` by default) that downloads the rows as they are on screen: the filter applied and the sort on screen, one column each with the headers on top and the row's own value at the column's `key`, whatever a `@cell` block draws. A value starting a formula (`=`, `+`, `-`, `@`, a tab or a carriage return) gets a leading apostrophe so a spreadsheet reads text, a number is left alone, and the file is UTF-8 with a byte order mark. Over a `list` it exports the rows loaded so far, so give it an address to export them all.
  - For rows the page holds only a part of, give a string: `Table(exportable="/orders.csv" filterParam="q")` links that address, with the sort as `sort` and `direction` and the typed text under `filterParam` (`q` without one). The endpoint reads them and answers with `new Response(toCsv(rows, columns), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="orders.csv"' } })`; `toCsv(rows, columns)` comes from the package.
- `pageSize={20}` draws the rows a page at a time with a `Pagination` under them: its summary (`21–40 of 134`) beside the pages, the pages counting the rows the filter keeps, and a sort or a typed filter starting again from the first. `pageSizes={[10, 25, 50]}` adds links that change the size, and `onPageChange(page, size)` hears each change (a new size restarting at page 1). The page and a size picked live in the address, `?page=` and `?limit=` (`pageParam`, `limitParam`; a size is taken only when `pageSizes` lists it), read from the request on the server too, so the pager's links open their page, a middle click or a shared URL included. `page={n}` makes the page the app's: the table leaves the address alone and the app sets it from `onPageChange`. The `pager` part styles the Pagination. A table over a `list` or a `virtual` one throws with a `pageSize`, as they page or window their rows themselves.
- `virtual` draws only the rows in view, between two spacer rows standing for the others, so a table of ten thousand rows and more stays light. The table scrolls in a box of its own, 70vh tall unless `--table-height` says otherwise, headers kept on top; rows start at an estimated 48px and take the height they measure (stacked cards included). The table is `aria-rowcount` and each row `aria-rowindex`, so a screen reader hears the real position. Filtering, sorting, selection and the CSV export work on all the rows. It is decided once, when the table is made; the server draws the first screenful only, and an `aria-label` names the scroll box. The box takes the focus to scroll by keyboard (arrows, Page Up and Down, Home, End); find-in-page sees the drawn rows alone, and a focused control in a row that scrolls out of the window loses its focus, so keep a filter for finding a row.
- A column also takes `width` and `minWidth` (a number is pixels, a string any CSS length), `sticky: 'start' | 'end'` (one column per edge, kept in view while the table scrolls sideways; a stacked card ignores it), `hidden`, `class` (added to its header, cells and footer) and `footer`. `width` and `minWidth` are ignored by a stacked card too.
- `@header(column)` draws a column's header in place of its `header` text, inside its sort button when sortable; the text stays the card label, the CSV header and the column toggle's label. `footer` on a column adds a foot (`tfoot`) with one cell per shown column; `@footer(column)` draws those cells instead of the text and gives every shown column a cell. Neither: no foot.
- `label="Planets"` is a caption only screen readers see, naming the table. When the table scrolls (wider or taller than its box, measured after mount and on every resize, `onScrollChange(scrolls)` hears the change) its box takes `tabindex="0"`, so a keyboard scrolls it, and `role="region"` named by `aria-label` (yours wins) or `label`; a table that does not scroll adds no focus stop, and a `virtual` one always scrolls.
- `columnToggle` puts a `Columns` button (`columnsLabel`) above the rows opening a list of checkboxes, one per column with a `header`. The columns start hidden as `hidden` says, or as `hiddenColumns={keys}` says (a new list from the parent is followed), and `onHiddenColumnsChange(keys)` hears each change with the keys now hidden. A hidden column is not drawn nor exported, still sorts by the URL's `sortParam`, and a `footer` of it goes with it.
