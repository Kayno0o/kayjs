---
description: Links to the pages of a list through the URL's query, rendered on the server.
---

<Demo name="pagination/basic" />

## From the URL

`page` is the page on screen and `pages` how many there are. `url` is the current URL, `ctx.url` in a route: each link keeps its path and query and sets the page parameter, so every page has a URL of its own and no island is needed.

## From paginate()

`of` takes a page kay's `paginate()` gave, `Pagination(of={list})`, and links each page at its own path, `/blog`, `/blog/2`, rather than through the query. See [Pages of a list](/guides/content#pages-of-a-list).

## Parameter and neighbours

`param` renames the query parameter, `page` by default, and `siblings` is how many pages show on each side of the current one.

<Demo name="pagination/options" />

## A list of unknown length

Give `page` and `more` instead of `pages`, with `url`. Only Previous and Next are drawn, and Next shows while `more` is true. Use it when counting the rows costs too much.

## By offset

Give `offset`, `limit`, `more` and `url` to page by row. Each link sets `?offset=40`, a page holding `limit` rows, and `param` renames the parameter from `offset`.

## Total and page size

Give `total` and `pageSize` in place of `pages` and the pages follow from the rows, with a summary beside the links, `21–40 of 134`. `rangeLabel` words it: a string filling `{from}`, `{to}` and `{total}`, or a function of `{ from, to, total }`.

`sizes` adds a link for each page size, such as `sizes={[10, 25, 50]}`. Each link sets `limitParam`, `limit` by default, and drops the page, so a new size starts from the first page. Read the size from that parameter in the route and pass it back as `pageSize`. The sizes stay while the rows outgrow the smallest, even on one page, so a size picked past the end can be undone. A single page still shows its summary.

## In the browser

A list an island pages in memory has no address to change. Give `onPage` and the links answer a click instead: a plain click calls it with the page, or with the offset for a list paged by offset, and the event, and the browser does not navigate.

Each link keeps its real address, so a middle click or a new tab still opens it, and a handler returning `false` lets the browser follow the link too. The component keeps the page on screen itself and follows `page` when you change it, so setting `page` in the handler is optional:

```kay
---
import Pagination from '@kaynooo/kayjs-ui/pagination.kay'
import { signal } from 'kay'

const rows = Array.from({ length: 45 }, (_, index) => `Row ${index + 1}`)
const page = signal(1)
---
ul
  for row of rows.slice((page() - 1) * 10, page() * 10) key={row}
    li {row}
Pagination(page={page()} total={rows.length} pageSize={10} onPage={next => page = next})
```

`onSize` does the same for the page size links. Only an island can pass a handler, and `url` can be left out. A table does all of this itself with its `pageSize`.

## Labels

`label` names the navigation for screen readers, `Pagination` by default. `previousLabel` and `nextLabel` word the two links, `Previous` and `Next` by default.

## Your own Previous and Next

`@step(direction)` draws the content of Previous and Next in place of their words, such as an icon, `direction` being `'previous'` or `'next'`. `previousLabel` and `nextLabel` still name the links for screen readers.

`url` can be left out: each link then keeps the address the page has, with the page parameter set.
