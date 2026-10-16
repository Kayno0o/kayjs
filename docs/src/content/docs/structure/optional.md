---
title: '[[optional]].kay'
order: 7
description: A page serving its folder's URL with or without one more segment.
path: src/routes/[[optional]].kay
---

A param in double brackets may be left out of the URL. `blog/[[page]].kay` serves both `/blog` and `/blog/2`, with `ctx.params.page` a `string | undefined`.

```kay
--- server
const number = Number(ctx.params.page ?? '1')
---
h1 Page {number}
```

It serves its folder's own URL. An `index.kay` beside it would serve the same path, which stops the server, so `blog/index.kay` and `blog/[[page]].kay` cannot live together.

An optional param takes a [matcher](/structure/matcher) as a plain one does, as in `[[page=integer]].kay`.

A `prerender` list leaves the param out of an entry to prerender the path without it.

<ReadMore href="/essentials/routing#dynamic-routes">Dynamic routes in the routing guide.</ReadMore>
