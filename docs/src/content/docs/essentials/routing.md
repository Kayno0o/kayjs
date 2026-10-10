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

## Loading data

A page reads its data in a `--- server` fence, with the request in `ctx`. See [Data loading](/essentials/data-loading).

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
export const prerender = true
---
```

A page with params lists the ones to build. Passing a content collection builds one page per entry:

```kay
--- server
import { posts } from '../../content.config'

export const prerender = posts
---
```

<Callout type="note">

Add `export const revalidate = '1h'` to rebuild a prerendered page in the background once it is older than that.

</Callout>

## Redirects

Old URLs go in `kay.config.ts`:

```ts
export default defineConfig({
  redirects: {
    '/blog/:slug': '/posts/:slug',
  },
})
```

<ReadMore href="/llms/routing">Matchers, server islands, rewrites, base path and static export are in the full routing reference.</ReadMore>
