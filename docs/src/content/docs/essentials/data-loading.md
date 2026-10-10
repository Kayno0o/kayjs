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

Top-level `await` works, and a layout's and a page's loads run in parallel.

## The request

The fence's `ctx` holds the request:

| Property | What it gives |
| --- | --- |
| `ctx.params` | Route params, typed from the file name |
| `ctx.url` | The request URL |
| `ctx.query` | Search params, typed by the page's `query` schema |
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

A page exports a `query` schema to read the search params typed. A value the schema refuses renders `_error.kay` with status 400.

```kay
--- server
import { s } from 'kay'

export const query = s.Object({
  q: s.String({ default: '' }),
  page: s.Optional(s.Integer()),
})

const { q, page = 1 } = ctx.query
---
h1 Results for {q}, page {page}
```

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

`notFound()` renders the nearest `_404.kay`, `deny()` renders `_error.kay` with that status and message.

<Callout type="warning">

`ctx.redirect` goes to any http(s) URL, so a `?next=` param goes through `localPath(value, fallback)` from `kay`: `ctx.redirect(localPath(ctx.query.next, '/account'))`.

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

`defineEnv` reads `process.env` once against a schema when the server boots, typed, and stops the boot naming every missing or refused variable.

```ts
// src/env.ts
import { s } from 'kay'
import { defineEnv } from 'kay/server'

export const env = defineEnv(s.Object({
  DATABASE_URL: s.String(),
  PORT: s.Integer({ default: 3000 }),
}))
```

Import `env` from server code: a fence, a `.ts` module or the server entry. An island never sees it.

<ReadMore href="/llms/server">Locals, sessions, guards and the environment variables an island may read are in the full server reference.</ReadMore>
