---
title: '[param=matcher].kay'
order: 10
description: A param a matcher checks, and hands the page as the value it returns.
path: src/routes/[param=matcher].kay
---

A matcher after the param's name checks the segment. `items/[id=integer].kay` serves `/items/42` only, with `ctx.params.id` a `number`:

```kay
--- server
import { findItem } from '../../items'

const item = await findItem(ctx.params.id) ?? ctx.notFound()
---
h1 {item.name}
```

The matcher returns the value `ctx.params` hands the page, typed as it returns it, or `undefined` to refuse the URL. kay ships `integer`, `uuid` and `slug` in `kay/params`, and a project adds its own in [`src/params/`](/structure/params). A matcher nobody provides stops the server.

A URL the matcher refuses falls through to the page without one serving the same path, `items/[slug].kay` beside `items/[id=integer].kay`, and is a 404 when none does. An [optional param](/structure/optional) takes a matcher too, `[[page=integer]].kay`.

<ReadMore href="/llms/routing">Matchers in full, in the routing reference.</ReadMore>
