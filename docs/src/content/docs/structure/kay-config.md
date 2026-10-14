---
title: kay.config.ts
order: 22
description: The project's settings, read by the server and every command.
path: kay.config.ts
---

Settings live in an optional `kay.config.ts` at the project's root, read by `pages()` and every command. It exports its config by default:

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  lang: 'en',
  seo: { name: 'My app', titleTemplate: '%s | My app' },
})
```

It holds the site's language and SEO defaults, its locales, redirects, build plugins such as Tailwind's, and the libraries it mounts in `extensions`. Options passed to `pages()` or `testSite()` win over it key by key.

<ReadMore href="/reference/config">Every option, grouped by what it sets.</ReadMore>
