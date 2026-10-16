---
title: '[...rest].kay'
order: 8
description: A catch-all page serving every path under its folder, at any depth.
path: src/routes/[...rest].kay
---

Three dots before a param's name catch the rest of the path. `docs/[...path].kay` serves `/docs/a/b/c` and any other path under `/docs`, read as `ctx.params.path`.

```kay
--- server
const path = ctx.params.path
---
h1 {path}
```

A catch-all is the last page tried. A fixed name wins over a [param](/structure/param), and a param over a catch-all.

The first segment telling two pages apart decides, so `/docs/intro` goes to `docs/[...path].kay` rather than `[section]/[page].kay`.

<ReadMore href="/essentials/routing#dynamic-routes">Dynamic routes in the routing guide.</ReadMore>
