# Caching and streaming

## Caching

`cached(key, ttl, load)` from `kay/cache` keeps what a load fetches for `ttl`, seconds or a string such as `'5m'`, shared by every request in the process:

```kay
--- server
import { cached } from 'kay/cache'
import { listPosts } from '../data'

const posts = await cached('posts', '5m', listPosts)
---
```

- Concurrent calls for a key missing from the cache share one `load`.
- Past `ttl`, the next call still gets the stale value and refreshes it in the background, so no request waits on a refresh.
- A first load that throws throws to its callers and keeps nothing. A refresh that throws is logged and keeps the stale value, trying again a minute later at most.
- For a visitor in preview mode (see [Preview mode](content.md#preview-mode)), every call runs `load` and keeps nothing, so they see what it gives now.
- `invalidate(key)`, or `invalidate(key => key.startsWith('post:'))`, drops keys so the next call loads afresh: call it from the action that changed what they hold. A load already running for a dropped key never lands in the cache.
- The value is the same object for every caller, so it is never mutated. At most 10,000 keys are kept, the least recently written going first.
- The cache lives in the process: each server process keeps its own, and `kay dev` empties it on every change.

A value that should outlive a restart, such as one a paid or rate-limited API gives, names a store:

```ts
import { cached, sqliteCache } from 'kay/cache'

const disk = sqliteCache('data/cache.sqlite')
const reviews = await cached('reviews', 86_400, fetchReviews, { store: disk })
```

- A key missing from memory is read from the store before `load` runs, and each load writes it back, so a restart, a deploy or `kay dev` reloading starts from what was kept; a stale one is given and refreshed as above.
- The processes of one machine share a SQLite store. Each keeps its copy in memory, and an `invalidate` in one process empties the store at once and reaches the others' copies within about half a second, through an events table each process polls once it has opened the store: a string key always, a function's keys as far as that process and the store know them. A load another process had already started may still write the old value back.
- `invalidate` empties a `sqliteCache` from the moment it opens, so an action after a restart reaches what it kept; a store of your own, once a `cached` call has named it.
- A key belongs to one store: once in memory, it is read and written there whatever store a later call names.
- A store that fails to write, locked or full, is logged and the value kept in memory. Rows are never swept, since a stale one is still served: `invalidate` keys a site stops using, such as those of deleted posts.
- The value goes through devalue, as session data does: dates, maps and sets survive, and a value holding a function or a class instance throws on its first load, keeping nothing; on a refresh, it is logged and the stale value kept.
- `sqliteCache` is server-only: in the browser, `kay/cache` has `cached` and `invalidate` alone.
- `CacheStore` is the shape of a store, synchronous so that `invalidate` is done when it returns: `get(key)` giving `{ text, freshUntil }`, `set(key, text, freshUntil)`, `delete(key)` and `keys()`, plus, optionally, `publish(message)` and `subscribe(listener)` carrying invalidations between processes, as a Redis channel would.
- In the `server` and `app` templates' image the app runs as `nobody`, so the store's directory is a mounted volume it can write.

## Streaming

A load waits for every `await` in its server fence before the page renders. A value the page can show later is left unawaited instead, and rendered by an `await` block:

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

- The page goes out at once with the block under `await`. Each `then` block streams in as its value resolves, in whatever order they do, swapped in by a few bytes of inline script; islands inside it hydrate when it lands.
- `await value then name` on one line has no pending block. `catch error` binds the rejection; without `catch`, a rejection removes the pending block and is logged. A `then` block that throws while rendering is a bug, not a rejection: it removes the pending block and is logged too, never showing `catch`.
- A promise rejecting before the page renders it would crash the server, so kay handles one a server value holds where it is declared, as `defer()` from `kay` does: an `await` block naming it, `await comments`, needs nothing more. A promise reached any other way, `await data.comments` or a prop, is made with `defer()`, which `kay check` reports when it is not; a value that is no promise renders at once.
- Status, headers and cookies are sent before the first block, so a streamed block cannot redirect or set them, and a `head` block inside one is ignored. A block renders on its own, outside its layouts, and an `await` inside a pending block renders its own pending block only.
- The response stays open until the last value settles, an empty comment going out every 5 seconds meanwhile, so neither Bun, which closes a connection idle for 10 seconds by default, nor a proxy in front closes it under a slow value.
- In an island, the server sends the pending block and the browser renders the rest once the value settles.

## Rendering to a string

`renderToString(Component, props)` from `kay/server` renders a component outside a page, for a mail, a feed or a file, and resolves with its markup:

```ts
import { renderToString } from 'kay/server'
import Receipt from './receipt.kay'

const html = await renderToString(Receipt, { order })
```

- Its `await` blocks are waited for and rendered in place, each `then` block or, once its value rejects, its `catch` block; a value rejecting with no `catch` block rejects the render, so nothing goes out with part of it missing.
- Islands render their server markup, with no script to run them, and a `head` block sets nothing. The props argument is left out for a component taking no required prop.
- Called while an action or a page runs, `t()` and `locale()` from `kay/i18n` read the request's locale; elsewhere, as in a job, they throw.
