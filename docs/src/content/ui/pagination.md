---
description: Links to the pages of a list through the URL's query, rendered on the server.
---

<Demo name="pagination/basic" />

## From the URL

`page` is the page on screen and `pages` how many there are. `url` is the current URL, `ctx.url` in a route: each link keeps its path and query and sets the page parameter, so every page has a URL of its own and no island is needed.

## Parameter and neighbours

`param` renames the query parameter, `page` by default, and `siblings` is how many pages show on each side of the current one.

<Demo name="pagination/options" />
