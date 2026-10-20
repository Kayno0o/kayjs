---
title: routes/
order: 1
description: The site's pages, layouts and endpoints, each file's path its URL.
path: src/routes/
---

Every `.kay` file in `src/routes/` is a page served at its path. It is the only folder a project needs.

<FileTree tree="
src/routes/
  index.kay  /
  about.kay  /about
  blog/
    index.kay  /blog
    [[slug].kay](/structure/param)  /blog/:slug
  [_layout.kay](/structure/layout)  wraps every page
  [llms.txt.ts](/structure/endpoint)  /llms.txt
" />

A file starting with `_` is not a route. [`_layout.kay`](/structure/layout), [`_404.kay`](/structure/not-found), [`_error.kay`](/structure/error), [`_guard.ts`](/structure/guard) and [`_actions.kay`](/essentials/forms-and-actions#actions-shared-by-pages-and-components) apply to the folder they sit in and below. Any other file starting with `_` is not a route either.

A `.ts` file whose name keeps an extension before `.ts` is an [endpoint](/structure/endpoint). Any other `.ts` file stays a helper, as do `.test.ts` and `.d.ts` files.

A page URL ending in a slash redirects to the one without, so `/about/` goes to `/about`. Links are plain `a` tags, and `kay check` reports a link to a page that does not exist.

```kay
a(href="/about") About
```

<ReadMore href="/essentials/routing">How pages match URLs, their settings, prerendering and redirects.</ReadMore>
