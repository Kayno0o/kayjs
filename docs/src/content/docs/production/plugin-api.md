---
title: Plugin API
description: Extend Kay v2 cleanly with KayPlugin hooks — server routes & middleware, build and post-prerender hooks, kay check rules, Bun.build plugins, HTML transforms, and custom CLI commands.
section: production
order: 3
---

Every first-party package in Kay v2 is built exclusively on the public `KayPlugin` interface, with zero special cases in core.

## `KayPlugin` contract

```ts
import { definePlugin } from '@kayjs/kay/config'

export function myPlugin() {
  return definePlugin({
    name: 'my-plugin',

    // Register global middleware, custom routes, URL rewrites, or shared server services
    server(api) {
      api.use(async (ctx, next) => {
        ctx.locals.startedAt = performance.now()
        return next()
      })
      api.route('GET', '/health', ctx => ctx.json({ ok: true }))
      api.route('POST', '/webhook', ctx => ctx.json({ received: true }), { csrf: false })
    },

    // Observe unhandled errors from routes, actions, or plugins
    onError({ error, request, source }) {
      console.error(`[${source}] ${request.url}`, error)
    },

    // Emit hashed client assets, public files, <link> styles, <head> tags, or build data
    build(ctx) {
      ctx.emitPublic('robots.txt', 'User-agent: *\nAllow: /\n')
      ctx.setData({ builtAt: Date.now() })
    },

    // Run after Step 3 prerendering (route.prerendered & publicFiles are populated)
    afterPrerender(ctx) {
      // Ideal for sitemaps, feeds, or inspecting generated static files
    },

    // Expand prerendered URLs (used by @kayjs/i18n)
    prerenderPaths(paths) {
      return paths
    },

    // Post-process rendered HTML (pages, <Suspense> shells, _error.tsx, _404.tsx)
    transformHtml(html, ctx) {
      return html
    },

    // Native Bun.build plugins per target ('client' | 'server' | 'compile')
    bunPlugins: ({ root, assetPrefix, minify, target }) => [],

    // Global CSS files or optional client bootstrap script
    css: ['src/plugin.css'],
    clientEntry: undefined,

    // Validate plugin invariants during `kay check`
    check(ctx) {
      // ctx.error('missing required file'), or ctx.warn('...') for what may be intended
    },

    // Extra paths for `kay dev` to watch
    watchPaths: ['src/content'],

    // Custom CLI subcommands (`kay my-cmd`)
    commands: {
      'my-cmd': async (args, root) => {
        console.log('Running in', root, args)
      },
    },
  })
}
```

## Build-to-server handoff & service sharing

- **Runtime state**: A plugin creates its timers, connections and caches in `server(api)` and releases them in `api.onShutdown()`, never in its factory. The app's bundled config is evaluated once, and `kay dev` may start several servers on the same plugin instance, each one before the last shuts down. An edit to `kay.config.ts` or a file it imports starts a new `kay dev` process, so in-memory state does not outlive it. The hooks also run when `kay start` or a compiled binary receives `SIGTERM`, and the process waits for them before it exits. A hook that throws is logged with the plugin's name, and the other hooks still run, as with `onError`.
- **Build and runtime instances**: `build`, `afterPrerender`, `prerenderPaths`, `check`, `commands`, `css` and `bunPlugins` run on the config `kay build` loads itself. `server`, `head` and `transformHtml` run on the app's bundled config, the same copy its routes import, prerendered pages included.
- **`ctx.setData(data)` / `api.getBuildData()`**: Persists JSON-serializable plugin data into `manifest.pluginData[plugin.name]` so it survives cold starts and `kay build --compile`.
- **`provide(key, value)` / `inject(key)`**: Available on both `BuildPluginContext` and `ServerPluginAPI` to share services between plugins without module-level singletons.
- **Per-route assets**: Use `ctx.addRouteStyle(routePath, href)` and `ctx.addRouteHead(routePath, html)` when an asset belongs on one route rather than every page.
- **Route headers**: an `api.route()` response gets the app's security headers. An HTML response without its own `content-security-policy` gets the app's CSP, with a hash for each of its `<style>` blocks.
- **Route CSRF**: `api.route()` enforces `Origin` / `Sec-Fetch-Site` on unsafe methods by default. Pass `{ csrf: false }` for webhooks or bearer-token endpoints (such as `@kayjs/mcp`).

## Helpers for plugin code

The first-party plugins use these instead of keeping their own copies, and a third-party plugin can do the same.

- **`isInside(dir, target, { orSame })`** from `@kayjs/kay/config`: whether `target` lies under `dir`. The folder itself counts only with `orSame: true`. Paths are compared as written, so call `realpathSync` on both first when a symlink must not lead out.
- **`readStringFields(request)`** from `@kayjs/kay/server`: the string fields of a JSON object, urlencoded or multipart body, the last of a repeated name winning. Files, numbers and arrays are dropped. The record has no prototype, so a `__proto__` field is an ordinary field. A malformed body throws: answer 400.
- **`wantsJson(request)`** from `@kayjs/kay/server`: whether the client sent or asked for JSON, to answer an error as JSON rather than as a redirect or a page.
- **`safeRedirect(target, fallback)`** from `@kayjs/kay/server`: `target` when it is a path on this site, otherwise `fallback`.
- **`escJson(json)`** from `@kayjs/kay/server`: JSON text made safe inside a `<script>` element, such as JSON-LD or a JSON data block. It escapes `<` and the two Unicode line separators, and the result still parses to the same value.
- **`safeEqual(a, b)`** from `@kayjs/kay/server`: compares two secrets, such as a bearer token or an OAuth state, in constant time. Both are hashed first, so the time taken does not reveal their length either.
