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

## Labels

`label` names the navigation for screen readers, `Pagination` by default. `previousLabel` and `nextLabel` word the two links, `Previous` and `Next` by default.

## Your own Previous and Next

`@step(direction)` draws the content of Previous and Next in place of their words, such as an icon, `direction` being `'previous'` or `'next'`. `previousLabel` and `nextLabel` still name the links for screen readers.

`url` can be left out: each link then keeps the address the page has, with the page parameter set.
