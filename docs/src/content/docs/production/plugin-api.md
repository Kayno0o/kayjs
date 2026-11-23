---
title: Plugin API
description: Extend Kay v2 cleanly with KayPlugin hooks — server routes & middleware, build asset emission, Bun.build plugins, HTML transforms, and custom CLI commands.
section: production
order: 3
---

Every first-party package in Kay v2 is built exclusively on the public `KayPlugin` interface — with zero special cases in core.

## `KayPlugin` contract

```ts
import type { KayPlugin } from 'kay/server'

export function myPlugin(): KayPlugin {
  return {
    name: 'my-plugin',

    // Register global middleware, custom routes, or URL rewrites
    server(api) {
      api.use(async (ctx, next) => {
        ctx.locals.startedAt = performance.now()
        return next()
      })
      api.route('GET', '/health', ctx => ctx.json({ ok: true }))
    },

    // Emit hashed client assets, public files, <link> styles, or <head> tags
    build(ctx) {
      ctx.emitPublic('robots.txt', 'User-agent: *\nAllow: /\n')
    },

    // Expand prerendered URLs (used by @kayjs/i18n)
    prerenderPaths(paths) {
      return paths
    },

    // Post-process rendered HTML
    transformHtml(html, ctx) {
      return html
    },

    // Native Bun.build plugins (e.g. Tailwind, icons, images)
    bunPlugins: ({ root, assetPrefix, minify }) => [],

    // Global CSS files or optional client bootstrap script
    css: ['src/plugin.css'],
    clientEntry: undefined,

    // Custom CLI subcommands (`kay my-cmd`)
    commands: {
      'my-cmd': async (args, root) => {
        console.log('Running in', root, args)
      },
    },
  }
}
```
