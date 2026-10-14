---
title: server.ts
order: 19
description: The server entry, mounting the pages on an Elysia server.
path: src/server.ts
---

`src/server.ts` mounts the pages on an Elysia server:

```ts
import { Elysia } from 'elysia'
import { pages } from 'kay/server'

export const app = new Elysia().use(await pages()).listen(3000)
```

Exporting `app` lets `kay check` check links against your own routes and type `ctx.locals`, from what the app's Elysia plugins add. `kay dev` and `kay build --compile` run this entry by default, and `--entry` names another.

A static site has no server entry: `kay dev` serves the pages itself, until a `src/server.ts` is written.

<ReadMore href="/getting-started/project-structure#the-server-entry">The server entry in Project structure.</ReadMore>
