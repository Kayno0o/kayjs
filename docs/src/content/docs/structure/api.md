---
title: api/
order: 12
description: Elysia modules, each mounted at /api plus its path.
path: src/api/
---

Each `.ts` module in `src/api/` exports a `KayPlugin` by default (`api()`, an Elysia instance in kay 1.x), and kay mounts it at `/api` plus its path, with nothing to register. `src/api/notes.ts` serves `/api/notes`.

```ts
import { s } from 'kay'
import { api } from 'kay/server'
import { addNote, listNotes } from '../data'

export default api()
  .get('/', () => listNotes(''))
  .post(
    '/',
    ({ body }) => addNote(body.text),
    { body: s.Object({ text: s.String() }) },
  )
```

`api()` is an Elysia instance whose handlers read the app's `locals`, so `({ user })` is typed. Its handlers read `guard` and `once` as a page does, `guard` typed by naming what the guards return, `api<{ org: Org }>()`. A `derive` or `resolve` of the module's own runs before its guards, so `guard` is empty there.

A [`_guard.ts`](/structure/guard) in `src/api/` protects its routes as it protects pages. A route at the path of a page, a public file, an endpoint or a redirect stops the server at boot.

A single file a static export should write, such as `llms.txt`, is an [endpoint file](/structure/endpoint) in `src/routes/` instead.

<ReadMore href="/guides/api-routes">API routes, calling them typed from an island, server-sent events and websockets.</ReadMore>
