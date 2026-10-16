---
title: '[param].kay'
order: 6
description: A page whose URL takes a value in one segment, read from ctx.params.
path: src/routes/[param].kay
---

A segment in brackets is a param, read from `ctx.params` in the page's server fence. `blog/[slug].kay` serves `/blog/hello`, with `ctx.params.slug` holding `hello`.

```kay
--- server
import { findPost } from '../../posts'

const post = await findPost(ctx.params.slug) ?? ctx.notFound()
---
h1 {post.title}
```

`ctx.params` is typed from the file name. A folder can be a param too. `orgs/[org]/` gives every page under it `ctx.params.org`, and its [guard](/structure/guard) reads it as `params.org`.

When two pages match a URL, a fixed name wins over a param, and a param over a [catch-all](/structure/rest).

Two pages serving one path stop the server, whatever they name their params, unless one has a [matcher](/structure/matcher). That is `todos/[id].kay` beside `todos/[slug].kay`.

## Prerendering a param page

A page with params is rendered per request, unless its `prerender` setting lists the params to build.

```kay
--- server
import { posts } from '../../content.config'

export const page = { prerender: posts }
---
```

<ReadMore href="/essentials/routing#dynamic-routes">Dynamic routes in the routing guide.</ReadMore>
