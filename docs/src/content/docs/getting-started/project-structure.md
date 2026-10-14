---
title: Project structure
order: 4
description: Where the files of a kay project live and what the two entry files look like.
---

A project made by `kay new` looks like this. Only `src/routes` is required.

<FileTree tree="
my-app/
  src/
    [routes/](/essentials/routing)  pages and layouts, a file is a URL
    [components/](/essentials/components)  components shared by pages
    [api/](/guides/api-routes)  Elysia modules, served under /api
    [content/](/guides/content)  Markdown, JSON and YAML read by collections
    [content.config.ts](/guides/content)  the collections
    [server.ts](#the-server-entry)  the server entry
  [public/](/essentials/styling-and-assets#public-files)  files served as they are, at their path
  [kay.config.ts](#kayconfigts)  project settings
  tsconfig.json  extends kay's
  .kay/  generated types and build output, git ignored
" />

`.kay/` holds the generated types, the client build and the compile cache. Add it to `.gitignore`.

## The server entry

`src/server.ts` mounts the pages on an Elysia server:

```ts
import { Elysia } from 'elysia'
import { pages } from 'kay/server'

export const app = new Elysia().use(await pages()).listen(3000)
```

Exporting `app` lets `kay check` check links against your own routes and types `ctx.locals`. A static site has no server entry: `kay dev` serves the pages itself.

## kay.config.ts

Settings live in an optional `kay.config.ts` that exports its config by default:

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  lang: 'en',
  seo: { name: 'My app', titleTemplate: '%s | My app' },
})
```

`tsconfig.json` extends kay's:

```json
{ "extends": "kay/tsconfig.json" }
```

<ReadMore href="/llms/project">The reference lists every config option and how the server, the config and `pages()` options combine.</ReadMore>
