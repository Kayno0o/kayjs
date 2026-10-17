---
title: Routing
order: 3
description: Files in src/routes are pages, their path is their URL.
---

<FileTree tree="
src/routes/
  index.kay  /
  about.kay  /about
  blog/
    index.kay  /blog
    [[slug].kay](#dynamic-routes)  /blog/:slug
  [_layout.kay](#layouts)  wraps every page
" />

A file in `src/routes/` is a page, and its path is its URL. Links are plain `a` tags, and `kay check` reports a link to a page that does not exist.

```kay
a(href="/about") About
```

## Dynamic routes

A segment in brackets is a param. The page's server fence reads it from `ctx.params`.

```kay
--- server
import { findPost } from '../../posts'

const post = await findPost(ctx.params.slug) ?? ctx.notFound()
---
h1 {post.title}
```

| File | Matches |
| --- | --- |
| `[slug].kay` | `/blog/hello` |
| `[...path].kay` | `/docs/a/b/c`, any depth |
| `[[page]].kay` | `/blog` and `/blog/2` |
| `[id=integer].kay` | `/items/42` only, `ctx.params.id` a `number` |

When two pages match a URL, a fixed name wins over a param, and a param wins over a catch-all.

<Callout type="tip">

`ctx.params` is typed from the file name: `[id=integer]` gives a `number`, `[[page]]` a `string | undefined`.

</Callout>

## Layouts

A `_layout.kay` wraps every page in its folder and below. It renders the page at `slot`.

```kay
header
  a(href="/") Home
  a(href="/blog") Blog
main
  slot
```

Layouts nest, so `blog/_layout.kay` renders inside the root one. A folder in parentheses groups pages under a layout without changing their URL: `(marketing)/pricing.kay` is `/pricing`.

## Page settings

A page's settings are the keys of one object that its server fence exports.

```kay
--- server
export const page = { prerender: true, revalidate: '1h' }
---
```

`prerender`, `keep` and `revalidate` are covered under [Prerendering](#prerendering). `layouts: false` drops the layouts above the page. `query` is covered in [Data loading](/essentials/data-loading), and `sitemap` and `noindex` in [Head and SEO](/essentials/head-and-seo). `kay check` types the object, so an unknown key is an error.

## Loading data

A page reads its data in a `--- server` fence, with the request in `ctx`. See [Data loading](/essentials/data-loading).

## Endpoint files

A `.ts` file with an extension before `.ts` serves that path with what its `GET` returns. Use it for an `llms.txt`, a JSON feed or a CSV export.

```ts
// src/routes/feeds/[slug].json.ts
import type { EndpointContext } from 'kay'
import { feedOf } from '../../data'

export const page = { prerender: [{ slug: 'news' }] }

export function GET({ params }: EndpointContext<{ slug: string }>) {
  return Response.json(feedOf(params.slug))
}
```

`GET` receives the same `ctx` as a page, without the parts only a page has. It returns a string, a `Blob` or a `Response`. A string goes out as the type its extension names, such as `text/plain` for `llms.txt`. The guards above it run first, as they do for a page. `kay build --static` writes it to a file.

## Not found and errors

`_404.kay` renders for `ctx.notFound()` and for every URL no page serves. `_error.kay` renders when a page throws, and reads `ctx.error`.

```kay
--- server
const { status, message } = ctx.error
---
h1 Error {status}
p {message}
```

## Prerendering

A page that is the same for everyone can be rendered once at build time.

```kay
--- server
export const page = { prerender: true }
---
```

You often need no flag. `kay build` also keeps a page that reads nothing from its request or the clock, and serves it from memory.

`kay build` shows what it decided. Its route table says `prerendered`, `kept` or `on request` for each route. Under an `on request` page it names the file and line that stopped it, such as `src/routes/clock.kay:2 reads Date`.

To be told when a page stops being kept, say so in the page.

```kay
--- server
export const page = { keep: true }
---
```

When the page cannot be kept, `kay build` warns with the file and line. Set the `unkept-page` lint to `deny` in `kay.config.ts` to fail the build instead. A page that is not kept is rendered for each request. Guards run on every request either way, and development renders every page afresh.

A page that shows data another module changes between requests is caught as the app runs. The server then renders it for each request and warns once with its name. `prerender: false` says so up front.

A page with params lists the ones to build. Pass a content collection to build one page per entry.

```kay
--- server
import { posts } from '../../content.config'

export const page = { prerender: posts }
---
```

<Callout type="note">

Add `revalidate: '1h'` to `page` to rebuild a prerendered page in the background once it is older than that.

</Callout>

<ReadMore href="/llms/prerendering#prerendering">What makes a page keepable, how the run-time check works, and how kept pages treat locales and `trailingSlash`.</ReadMore>

### Server islands

`server` on a component call renders that component on each request, inside a page that is otherwise prerendered. Use it for a form with a fresh token, a greeting or a stock count. The rest of the page is prerendered, with no `prerender` flag needed.

```kay
--- server
import { issueToken } from '../contact'

const token = issueToken()
---
Hero
ContactForm(server token={token})
Reviews(server="defer")
```

`server` renders the island into the page before it is sent. `server="defer"` sends the page as prerendered, and the browser fetches the island as it nears the screen.

## Redirects

Old URLs go in `kay.config.ts`.

```ts
export default defineConfig({
  redirects: {
    '/blog/:slug': '/posts/:slug',
  },
})
```

## Pages from a library

A library can serve pages of its own, such as the sign-in and sign-up of kayjs-auth. List it once in `extensions`.

```ts
import { authPages } from '@kaynooo/kayjs-auth'
import { defineConfig } from 'kay/server'

export default defineConfig({ extensions: [authPages()] })
```

Its pages serve under their prefix, such as `/auth/login`, inside your layouts and guards. To change one, put your own file at the same path, `src/routes/auth/login.kay`. It replaces that page alone.

<ReadMore href="/guides/component-libraries">Writing your own library or extension.</ReadMore>

<ReadMore href="/llms/component-libraries#extensions">Writing an extension, its layouts, messages, API modules and config, page hooks and editor.</ReadMore>

<ReadMore href="/llms/routing">Matchers, the page settings in full, server island options such as `noscript`, rewrites, base path and static export are in the full routing reference.</ReadMore>
