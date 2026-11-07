---
title: feed.xml.ts
order: 11
description: A file served at its path with what its GET, POST or other method returns, such as a feed, an llms.txt or a webhook.
path: src/routes/feed.xml.ts
---

A `.ts` file in `src/routes/` whose name keeps an extension before `.ts` serves that path with what its `GET` returns. Use it for an `llms.txt`, a feed, a CSV export or a webhook, with no [API module](/structure/api).

| File | URL |
| --- | --- |
| `llms.txt.ts` | `/llms.txt` |
| `feeds/[slug].json.ts` | `/feeds/:slug.json`, read as `params.slug` |
| `exports/[year]/report.csv.ts` | `/exports/:year/report.csv` |

```ts
// src/routes/feeds/[slug].json.ts
import type { EndpointContext } from 'kay'
import { feedOf } from '../../data'

export const page = { prerender: [{ slug: 'news' }] }

export function GET({ params }: EndpointContext<{ slug: string }>) {
  return Response.json(feedOf(params.slug))
}
```

The file exports a handler for each method it answers: `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` or `OPTIONS`. A method it does not export answers 405 with an `Allow` header, `HEAD` follows `GET`, and `OPTIONS` lists what the file serves. `kay check` warns of an export that is no method, such as `post`.

A handler gets the same `ctx` a page does, minus what only a page has. That is `request`, `url`, `locale`, `params`, `query`, `cookies`, `locals`, `headers`, `redirect`, `notFound` and `deny`. Cookies and headers it sets go out with its answer.

It returns a string, a `Blob` or a `Response`. A string goes out as the type its extension names, `text/plain` for `llms.txt`.

```ts
// src/routes/hooks/stripe.json.ts
import type { EndpointContext } from 'kay'

export const page = { rateLimit: { max: 60, window: '1m' }, maxSize: '1mb' }

export async function POST({ request }: EndpointContext) {
  await handleEvent(await request.json())

  return Response.json({ received: true })
}
```

`page` takes `query` (a schema for `ctx.query`, a bad query answering 400), `rateLimit` (429 past it), `maxSize` (413 before the body is read) and `cors` (let other sites call the file, as an [API module](/structure/api) does). A cross-site form post from a browser is refused unless `cors` lets it in, and a request with no `Origin`, such as a webhook, goes through.

A 404 from the file, for a path whose extension no file takes or a `notFound()`, shows your `_404.kay` to a browser asking for HTML and stays plain text for anything else.

The guards above it run first, as they do for a page, and `kay build --static` writes its `GET` to a file.

A param is a plain `[name]` segment. A rest, an optional or a matcher param stops the server. A `.ts` file with no extension before `.ts`, such as `format.ts`, stays a helper.

<ReadMore href="/essentials/routing#endpoint-files">Endpoint files in the routing guide.</ReadMore>
