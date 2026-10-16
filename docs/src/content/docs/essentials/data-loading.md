---
title: Data loading
order: 4
description: A server fence runs on each request, reads the request through ctx and hands typed values to the template.
---

The `--- server` fence of a page or a layout runs on the server for each request. Every top-level name it declares reaches the template, typed, and none of the fence ships to the browser.

```kay
--- server
import { listPosts } from '../data'

const posts = await listPosts()
---
ul
  for post of posts
    li: a(href={`/blog/${post.slug}`}) {post.title}
```

Top-level `await` works.

## The request

The fence's `ctx` holds the request:

| Property | What it gives |
| --- | --- |
| `ctx.params` | Route params, typed from the file name |
| `ctx.url` | The request URL |
| `ctx.query` | Search params, typed by the `query` schemas of the page and its layouts |
| `ctx.cookies` | A `Bun.CookieMap`, changes are sent back |
| `ctx.locals` | What the app's Elysia `derive` adds, such as the signed-in user |

```kay
--- server
const user = ctx.locals.user
const theme = ctx.cookies.get('theme') ?? 'light'
---
p(class={theme}) Hello {user?.name}
```

## Query strings

A page sets a `query` schema in its `page` object to read the search params typed.

```kay
--- server
import { s } from 'kay'

export const page = {
  query: s.Object({
    q: s.String({ default: '' }),
    page: s.Optional(s.Integer()),
  }),
}

const { q, page: number = 1 } = ctx.query
---
h1 Results for {q}, page {number}
```

A layout declares the params every page under it shares the same way, in its own `page`, and reads them through `ctx.query` typed and validated like a page does. The pages under it do not repeat the schema: `ctx.query` is read once against the layouts' `query` and the page's merged, so a page reads a layout's params as its own. A layout's `ctx.query` holds the params of the layouts above it and its own.

```kay
--- server
import { s } from 'kay'

export const page = { query: s.Object({ period: s.String({ maxLength: 4, default: '24h' }) }) }

const { period } = ctx.query
---
nav Showing the last {period}
slot
```

A name two files of one route declare is accepted when their schemas are the same, and refused when they differ: `kay check` reports it on the later file, and the render fails for a schema it cannot compare. A special page (`_error.kay`, `_404.kay`) declares no query, and a page with `layouts: false` reads none of the dropped layouts' params.

## Redirect, not found and deny

These stop rendering:

```kay
--- server
import { findPost } from '../../posts'

if (!ctx.locals.user)
  ctx.redirect('/login')

const post = await findPost(ctx.params.slug) ?? ctx.notFound()

if (post.private && !ctx.locals.user.admin)
  ctx.deny(403, 'Members only')
---
h1 {post.title}
```

`notFound()` renders the nearest `_404.kay`, `deny()` renders `_error.kay` with that status and message. All three throw. At the top of a page they are statements, in a guard or an action they are `return`ed. A guard, an endpoint and an action read the same `ctx.redirect`, `ctx.notFound()` and `ctx.deny()`. A redirect answers 302 to a read and 303 to a post unless you give a status.

<Callout type="warning">

`ctx.redirect` goes to any URL, `//other.example/` included, so a `?next=` param goes through `localPath(value, fallback)` from `kay`: `ctx.redirect(localPath(ctx.query.next, '/account'))`. It gives `fallback` for anything that would leave the site, even once decoded, such as `/%2F/evil.example`.

</Callout>

## Streaming slow values

Leave a slow value unawaited and render it in an `await` block. The page goes out at once and the block streams in when the value resolves.

```kay
--- server
import { findPost, listComments } from '../../data'

const post = await findPost(Number(ctx.params.id)) ?? ctx.notFound()
const comments = listComments(post.id)
---
h1 {post.title}
await comments
  p Loading comments
then list
  ul
    for comment of list
      li {comment.body}
catch
  p Comments are unavailable
```

Caching a load with `cached()` is covered in [Caching and streaming](/guides/caching-and-streaming).

## Environment variables

`defineEnv` reads `process.env` once against a schema when the server boots and gives it back typed. A missing variable stops the boot.

```ts
// src/env.ts
import { s } from 'kay'
import { defineEnv } from 'kay/server'

export const env = defineEnv(s.Object({
  DATABASE_URL: s.String(),
  PORT: s.Integer({ default: 3000 }),
}))
```

Import `env` from server code. An island never sees it.

<ReadMore href="/llms/server">Locals, sessions, guards and the environment variables an island may read are in the full server reference.</ReadMore>
