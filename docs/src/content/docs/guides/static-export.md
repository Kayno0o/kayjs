---
title: Static export and base path
order: 9.1
description: Write the site as static files for a host with no server, and mount it under a path with base, withBase and trailingSlash.
---

`kay build --static` renders every page to a file, for any host that serves files: Forgejo Pages, GitHub Pages, a CDN or plain nginx.

```sh
kay build --static --outdir dist
```

`--outdir` is where the files go, `dist` by default. The build also writes the normal client build, so you can run it in place of `kay build`.

## What is written

Each page is written twice, as `about.html` and `about/index.html`. A host then finds it at `/about` and at `/about/`. The home page is `index.html`.

The browser build goes under `_kay/`. The files of `public/` are copied to the root. Every endpoint file, `llms.txt`, the sitemap, `robots.txt`, feeds, favicons and `404.html` are written too, the last from your `_404.kay`.

A redirect from `kay.config.ts` without params becomes a page that sends the browser on. Every redirect is also written to `_redirects`, which hosts such as Netlify and Cloudflare Pages read.

`sw.js` is written too. With `offline` on it is the worker that keeps the site for offline visitors. Without it, it is a worker that removes one an earlier deploy left, so no visitor is served a stale page.

Compressible files also get a `.br` and a `.gz` copy beside them, for a server that sends them as they are, such as nginx with `gzip_static`. Asset names carry a hash, so `_kay/` can be cached forever.

<ReadMore href="/llms/prerendering#static-export">Images, redirects, locales and how the output directory is cleared.</ReadMore>

## Pages that need a server

A page cannot be exported when only a server can answer it. The build fails and names each one.

That covers a page behind a guard, one exporting an action, one holding a server island, and one that redirects or answers another status than 200. A page with params and no `prerender` list cannot be exported either, nor can a module under `src/api/`.

List the values of a page with params in the `prerender` setting of its `page`, and it exports. Locales by domain need a server too.

<ReadMore href="/llms/prerendering#static-export">The full list of what cannot be exported, and how redirects become pages.</ReadMore>

## Mount the site under a path

`base` mounts the site under a path of its host. Pages does this under `/<owner>/<repo>`.

```ts
export default defineConfig({
  base: '/docs',
})
```

Write links without it, as `a(href="/about")`. kay puts the base in front of every root-relative `href`, `src` and `action` a page renders. It does the same for redirects, canonical links, the sitemap, `robots.txt`, feeds and the web manifest.

A route that starts like the base is no exception. Under `base: '/blog'`, `a(href="/blog/hello")` goes to `/blog/blog/hello`.

A server under `base` sits behind a proxy that takes the path off requests. kay's own routes stay at the root of the server.

## Use withBase in a script

A template needs nothing. A URL a script builds outside a template does, such as `location.assign()` or `fetch()`. Pass it through `withBase` from `kay`.

```ts
import { withBase } from 'kay'

location.assign(withBase('/about'))
```

On the server `withBase` leaves the path as it is, because kay adds the base itself. Island actions, their redirects and `localize()` already do this.

<ReadMore href="/llms/routing#base-path">How an island puts the base on its attributes and what the base touches in styles.</ReadMore>

## Trailing slashes

By default, a page URL ending in a slash redirects to the one without: `/about/` goes to `/about`. `trailingSlash` changes that.

```ts
export default defineConfig({
  trailingSlash: 'always',
})
```

| Value | `/about` | `/about/` |
| --- | --- | --- |
| `never` (default) | Served | Redirects to `/about` |
| `always` | Redirects to `/about/` | Served |
| `ignore` | Served | Served |

Under `always`, canonical links, the sitemap and the links in search results end in a slash too. An API route, an endpoint and an image keep the spelling that was sent.

A static export writes both `about.html` and `about/index.html`, so any value works on a plain file host. Set `trailingSlash` to the one your host redirects to.

<ReadMore href="/llms/prerendering#prerendering">How kept pages read `ctx.url.pathname` under each value.</ReadMore>
