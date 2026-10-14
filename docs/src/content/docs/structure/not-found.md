---
title: _404.kay
order: 3
description: The page shown, with status 404, for a URL nothing serves.
path: src/routes/_404.kay
---

`_404.kay` renders with status 404 for `ctx.notFound()` in its folder and below. The root one also answers every URL no page serves.

```kay
h1 Page not found
p: a(href="/") Back to the home page
```

A page calls `ctx.notFound()` when what its URL names does not exist:

```kay
--- server
import { findPost } from '../../posts'

const post = await findPost(ctx.params.slug) ?? ctx.notFound()
---
h1 {post.title}
```

The nearest `_404.kay` wins, wrapped by the layouts of its own folder, so `blog/_404.kay` can answer for the blog alone. Without one, a 404 renders [`_error.kay`](/structure/error).

<ReadMore href="/essentials/routing#not-found-and-errors">Not found and error pages in the routing guide.</ReadMore>
