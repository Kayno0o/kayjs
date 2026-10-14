---
title: feed.xml.ts
order: 11
description: A file served at its path with what its GET returns, such as a feed or an llms.txt.
path: src/routes/feed.xml.ts
---

A `.ts` file in `src/routes/` whose name keeps an extension before `.ts` serves that path with what its `GET` returns, for an `llms.txt`, a feed or a CSV export, with no [API module](/structure/api):

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

`GET` gets the `request`, `url`, `params` and `locals`, and returns a string, a `Blob` or a `Response`. A string goes out as the type its extension names, `text/plain` for `llms.txt`. The guards above it run first, as they do for a page, and `kay build --static` writes it to a file.

A param is a plain `[name]` segment: a rest, an optional or a matcher param stops the server. A `.ts` file with no extension before `.ts`, `format.ts`, stays a helper.

<ReadMore href="/essentials/routing#endpoint-files">Endpoint files in the routing guide.</ReadMore>
