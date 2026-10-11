---
title: Routing
order: 3
description: Files in src/routes are pages, their path is their URL.
---

```
src/routes/
├── index.kay          /
├── about.kay          /about
├── blog/
│   ├── index.kay      /blog
│   └── [slug].kay     /blog/:slug
└── _layout.kay        wraps every page
```

Links are plain `a` tags. kay swaps the next page in without a reload once a page has an island or a form, and `kay check` reports a link to a page that does not exist.

```kay
a(href="/about") About
```

## Dynamic routes

A segment in brackets is a param, read from `ctx.params` in the page's server fence:

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

<Callout type="tip">

`ctx.params` is typed from the file name: `[id=integer]` gives a `number`, `[[page]]` a `string | undefined`.

</Callout>

## Layouts

A `_layout.kay` wraps every page in its folder and below, rendering the page at `slot`:

```kay
header
  a(href="/") Home
  a(href="/blog") Blog
main
  slot
```

Layouts nest: `blog/_layout.kay` renders inside the root one. To group pages under a layout without changing their URL, put them in a folder in parentheses: `(marketing)/pricing.kay` is `/pricing`.

## Page settings

A page's settings are the keys of one object its server fence exports:

```kay
--- server
export const page = { prerender: true, revalidate: '1h' }
---
```

The keys are `prerender` and `revalidate` (see [Prerendering](#prerendering)), `layouts: false` to drop the layouts above the page, `query` (see [Data loading](/essentials/data-loading)), and `sitemap` and `noindex` (see [Head and SEO](/essentials/head-and-seo)). `kay check` types the object, so the editor completes the keys and an unknown one is an error. A setting exported under its own name, `export const prerender = true`, is a compile error, and `kay check --fix` moves it into `page`.

## Loading data

A page reads its data in a `--- server` fence, with the request in `ctx`. See [Data loading](/essentials/data-loading).

## Endpoint files

A `.ts` file whose name keeps an extension before `.ts` serves that path with what its `GET` returns, for an `llms.txt`, a JSON feed or a CSV export, with no API module:

```ts
// src/routes/feeds/[slug].json.ts
import type { EndpointContext } from 'kay'
import { feedOf } from '../../data'

export const page = { prerender: [{ slug: 'news' }] }

export function GET({ params }: EndpointContext<{ slug: string }>) {
  return Response.json(feedOf(params.slug))
}
```

`GET` gets the `request`, `url`, `params` and `locals`, and returns a string, a `Blob` or a `Response`. A string goes out as the type its extension names, `text/plain` for `llms.txt`. The guards above it run first, as they do for a page, and `kay build --static` writes it to a file, for each set of params its `prerender` lists.

A page and an endpoint cannot share a param path, `posts/[slug].kay` beside `posts/[slug].json.ts`: put the endpoint one level down, `posts/[slug]/feed.json.ts`. A `.ts` file with no extension before `.ts` stays a helper.

## Not found and errors

`_404.kay` renders for `ctx.notFound()` and for every URL no page serves. `_error.kay` renders when a page throws, reading `ctx.error`:

```kay
--- server
const { status, message } = ctx.error
---
h1 Error {status}
p {message}
```

## Prerendering

A page that is the same for everyone can be rendered once at build time:

```kay
--- server
export const page = { prerender: true }
---
```

A page with params lists the ones to build. Passing a content collection builds one page per entry:

```kay
--- server
import { posts } from '../../content.config'

export const page = { prerender: posts }
---
```

<Callout type="note">

Add `revalidate: '1h'` to `page` to rebuild a prerendered page in the background once it is older than that.

</Callout>

### Server islands

`server` on a component call renders that component on each request, inside a page otherwise prerendered: a form with a fresh token, a greeting, a stock count. A page reaching one prerenders with no `prerender` key:

```kay
--- server
import { issueToken } from '../contact'

const token = issueToken()
---
Hero
ContactForm(server token={token})
Reviews(server="defer")
```

`server` renders the island into the page before it is sent. `server="defer"` sends the prerendered page as is, and the browser fetches the island as it nears the screen.

## Redirects

Old URLs go in `kay.config.ts`:

```ts
export default defineConfig({
  redirects: {
    '/blog/:slug': '/posts/:slug',
  },
})
```

## Pages from a library

A library can serve pages of its own, such as kayjs-auth's sign-in and sign-up, listed once in `extensions`:

```ts
import { authPages } from '@kaynooo/kayjs-auth'
import { defineConfig } from 'kay/server'

export default defineConfig({ extensions: [authPages()] })
```

Its pages serve under their prefix, `/auth/login`, inside your layouts and guards. To change one, put your own file at the same path, `src/routes/auth/login.kay`: it replaces that page alone, and the library's others stay.

<ReadMore href="/llms/components#extensions">Writing an extension, its layouts, messages, API modules and config, and page hooks.</ReadMore>

<ReadMore href="/llms/routing">Matchers, server island options such as `noscript`, rewrites, base path and static export are in the full routing reference.</ReadMore>
