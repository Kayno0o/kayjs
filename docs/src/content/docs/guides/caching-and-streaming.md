---
title: Caching and streaming
order: 7
description: Keep slow loads in memory, and stream slow parts of a page in after the rest.
---

Each tool fits a different slow part.


| The slow part | Use |
| --- | --- |
| a value that is the same for every request, such as a list of posts or another service's feed | [`cached`](#caching-a-load) |
| a whole page that is the same for everyone | [the page cache](#page-cache) |
| a value the rest of the page can show without, such as comments under a post | [streaming](#streaming) |
| a part that differs per request in a page otherwise the same for everyone, such as a greeting | [a server island](/essentials/routing#server-islands) |

They combine. A streamed value can come from `cached`, and a prerendered page can hold server islands.

## Caching a load

`cached(key, ttl, load)` from `kay/cache` keeps what a load fetched for `ttl`, shared by every request in the process. `ttl` is in seconds or a string such as `'5m'`.

```kay
--- server
import { cached } from 'kay/cache'
import { listPosts } from '../data'

const posts = await cached('posts', '5m', listPosts)
---
```

Concurrent calls share one load. Past the `ttl`, the next call still gets the stale value and refreshes it in the background, so no request waits on a refresh.

Drop keys from the action that changed their data. A prerendered page that read a dropped key is rendered again on its next request, and so is a cached value built from it.

```ts
import { invalidate } from 'kay/cache'

invalidate('posts')
invalidate(key => key.startsWith('post:'))
```

To keep a value across restarts, name a store.

```ts
import { cached, sqliteCache } from 'kay/cache'

const disk = sqliteCache('data/cache.sqlite')
const reviews = await cached('reviews', 86_400, fetchReviews, { store: disk })
```

<Callout type="note">

The cache lives in the process, and every caller shares the value, so never mutate it. A `sqliteCache` is shared by the processes of one machine.

In the browser, `kay/cache` has `cached` and `invalidate` only. `kay check` reports `invalidatePage` or `sqliteCache` imported by an island.

</Callout>

## Page cache

A page that is the same for everyone is rendered once with `prerender: true` in its `page` object. Add `revalidate: '1h'` to rebuild it in the background. See [Routing](/essentials/routing#prerendering).

After a change, `invalidate('posts')` or `news.invalidate()` refreshes the prerendered pages that read that value or collection. Use `invalidatePage(path => path.startsWith('/news'))` from `kay/cache` for a page no data explains.

A page rendered per request that read the session, a cookie or how a form post went goes out as `Cache-Control: private, no-cache` with `Vary: cookie`. A CDN caching HTML then never hands one visitor's page to another.

A prerendered page keeps its public caching. A `cache-control` the page sets through `ctx.headers` wins.

## Streaming

A load waits for every `await` in its server fence before the page renders. Leave a slow value unawaited and render it with an `await` block. The page goes out at once, and the `then` block streams in when the value resolves.

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

Without `catch`, a rejection removes the pending block and is logged. Islands inside a streamed block hydrate when it lands.

An `await` block takes any promise, wherever it came from. A property, a prop or a promise a component made all work the same way.

```kay
--- server
const data = { comments: listComments(post.id) }
---
await data.comments
  p Loading
then list
  p {list.length} comments
catch
  p Comments are unavailable
```

A promise may fail before the page gets to its block. That crashes nothing, and the block still shows its `catch`.

Kay holds any promise that fails with nothing awaiting it, in your own code too, instead of stopping the server. It logs the failure after 30 seconds, or when the process ends, which then exits with code 1.

`defer()` from `kay` is no longer needed, though code that still calls it keeps working.

<Callout type="warning">

Status, headers and cookies are sent before the first block, so a streamed block cannot redirect or set them.

</Callout>

## Rendering to a string

`renderToString` renders a component outside a page, for a mail or a file.

```ts
import { renderToString } from 'kay/server'
import Receipt from './receipt.kay'

const html = await renderToString(Receipt, { order })
```

<ReadMore href="/llms/rendering">Stores, cross-process invalidation, failure behavior and streaming details are in the full rendering reference.</ReadMore>
