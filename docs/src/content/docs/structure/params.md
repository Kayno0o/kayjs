---
title: params/
order: 16
description: The project's own matchers, one file per matcher.
path: src/params/
---

`src/params/<name>.ts`, beside `src/routes/`, is the matcher a route names as `[id=<name>]`. Its default export takes the segment and returns the value `ctx.params` hands the page, or `undefined` to refuse the URL:

```ts
// src/params/even.ts
export default (value: string) =>
  Number(value) % 2 === 0 ? Number(value) : undefined
```

`items/[id=even].kay` then serves `/items/4` with `ctx.params.id` a `number`, and not `/items/3`. kay ships `integer`, `uuid` and `slug` in `kay/params`; a project's matcher of the same name wins over kay's.

<ReadMore href="/structure/matcher">How a page uses a matcher.</ReadMore>
