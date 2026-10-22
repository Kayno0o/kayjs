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

`cached(key, ttl, load)` from `kay/cache` keeps what a load fetched for `ttl`, shared by every request in the process. `ttl` is a string such as `'5m'`.

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

To have the pages that show a value change in every open tab when you drop it, add `live: true` to the `cached` call. See [Data from the cache](/guides/live-and-realtime#data-from-the-cache).

To keep a value across restarts, name a store.

```ts
import { cached, sqliteCache } from 'kay/cache'

const disk = sqliteCache('data/cache.sqlite')
const reviews = await cached('reviews', 86_400, fetchReviews, { store: disk })
```

### Your own store

A store is an object of `CacheStore`, from `kay/cache`. Its methods are synchronous, so `invalidate` is done when it returns.

```ts
import type { CacheStore } from 'kay/cache'

const store: CacheStore = {
  get: key => rows.get(key),
  set: (key, text, freshUntil) => rows.set(key, { text, freshUntil }),
  delete: key => rows.delete(key),
  keys: () => [...rows.keys()],
}
```

`get` returns `{ text, freshUntil }`, where `text` is the value kay serialized and `freshUntil` is a time in ms since the epoch. A store never parses `text`.

Two methods are optional. `dependencies()` reads which keys each value was built from without reading the values, which makes `invalidate` faster. `publish(message)` and `subscribe(listener)` let processes sharing the store tell each other what they invalidated.

Pass every message on exactly as it came, and never back to the process that published it: some carry only a clock reading, which lets pages that follow a key with `live: true` refresh even when the machines' clocks differ by a few seconds, once they have heard each other.

<Callout type="note">

The cache lives in the process, and every caller shares the value, so never mutate it. A `sqliteCache` is shared by the processes of one machine. It creates its file when the first value is stored, not when your code names it, so a build, a check or a test that loads the module writes nothing.

In the browser, `kay/cache` has `cached` and `invalidate` only. `kay check` reports `invalidatePage` or `sqliteCache` imported by an island.

</Callout>

## Page cache

A page that is the same for everyone is rendered once with `prerender: true` in its `page` object. Add `revalidate: '1h'` to rebuild it in the background. See [Routing](/essentials/routing#prerendering).

After a change, `invalidate('posts')` or `news.invalidate()` refreshes the prerendered pages that read that value or collection. Use `invalidatePage(path => path.startsWith('/news'))` from `kay/cache` for a page no data explains.

A page rendered per request that read the session, a cookie or how a form post went goes out as `Cache-Control: private, no-cache` with `Vary: cookie`. So does every answer behind a guard, whatever the guard read, such as an `Authorization` header, and every endpoint or API route answer behind one or that read the session, refusals included. A route that sets its own `cache-control` keeps it. A CDN caching HTML then never hands one visitor's page to another.

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

Without `catch`, a rejection renders the `catch` of the nearest `try` around the block, and with no `try` removes the pending block and is reported at its `await` line. Islands inside a streamed block hydrate when it lands. A form inside one is checked and sent by kay as one in the page is, with the page's locale words and its proof-of-work challenge.

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

### A value that arrives in parts

An `await` block also takes an async iterable, such as an async generator. Each value it yields is the whole so far. The `then` block renders it in place of the last one.

```kay
--- server
async function* reply() {
  let text = ''

  for await (const word of words())
    yield text += word
}

const answer = reply()
---
await answer
  p Thinking
then text
  p {text}
catch
  p The reply was cut short
```

The first part goes out at once. After that, kay sends at most one part every 50 ms, always the latest, and always the last one. In an island the block updates at most once a frame. An island inside a part is cleaned up, while it is still in the page, when the next part replaces it.

When the visitor leaves the page, kay stops the iterable, so a generator's `finally` runs.

The main use is a model's reply. [kayjs-ai](/libraries/kayjs-ai)'s `ask()` gives one, so the text streams into the block with no loop of your own.

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
