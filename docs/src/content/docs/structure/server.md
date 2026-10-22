---
title: server.ts
order: 19
description: The server entry, mounting the pages on an Elysia server.
path: src/server.ts
---

`src/server.ts` mounts the pages on an Elysia server.

```ts
import { Elysia } from 'elysia'
import { pages } from 'kay/server'

export const app = new Elysia().use(await pages())
```

The entry never calls `listen`: `kay dev`, `kay start` and the executable listen it on `PORT` (3000 by default) and `HOST`, and one that calls `listen` itself keeps its own port and address. The listen happens once the entry module has run to its end, so an entry that starts a `Bun.serve` server of its own is left alone, and one whose top-level code never ends is never listened.

Exporting `app` lets `kay check` check links against your own routes and type `ctx.locals`, from what the app's Elysia plugins add. `kay dev` and `kay build --compile` run this entry by default, and `--entry` names another.

A project with nothing custom on its server needs no entry. `kay dev`, `kay start` and `kay build --compile` serve the pages with a server of kay's own on `PORT` and `HOST`. Write a `src/server.ts` for your own routes or an `onStop` hook.

A plugin, a session or a job needs no entry: each `src/plugins/<name>.ts` default-exports an Elysia plugin (or a function building one), and kay uses them before the pages in the order of their file names, so `ctx.locals` is typed from them. A file starting with `_`, a test and a declaration are not plugins.

```ts
// src/plugins/session.ts
import { session } from 'kay/server'

export default session({ secret: process.env.SESSION_SECRET })
```

A plugin that needs another `.use`s it itself, which Elysia dedupes by `name`, so the order of the file names rarely matters.

<ReadMore href="/getting-started/project-structure#the-server-entry">The server entry in Project structure.</ReadMore>
