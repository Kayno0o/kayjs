---
title: Site search
order: 3.5
description: Index the pages kay build renders and search them from an island, with no search service, in each locale.
---

## Turning it on

Set `search: true` in `kay.config.ts`:

```ts
export default defineConfig({
  search: true,
})
```

`kay build` then indexes the text of every page it renders, the pages of your content collections among them, and `kay build --static` writes the index with the rest of the site. A page rendered per request, with no `prerender`, is not in it.

## A search box

`searchResults` follows a signal holding the query and gives the hits of the latest one:

```kay
---
import { searchResults, signal } from 'kay'

const query = signal('')
const { hits, error } = searchResults(query)
---
input(type="search" aria-label="Search" bind:value={query})
if error() !== undefined
  p The search could not load.
ul
  for hit of hits() key={hit.href}
    li
      a(href={hit.href}) {hit.page}
      if hit.heading as heading
        |  · {heading}
      p
        for part, i of hit.snippet key={i}
          if part.hit
            mark {part.text}
          else
            | {part.text}
```

[kayjs-ui](/libraries/kayjs-ui)'s [CommandPalette](/ui/command-palette#searching-the-pages) takes `siteSearch` for a search box ready made, behind Ctrl K, as on this site.

Each hit links a section of a page: the text above its first `h2`, `h3` or `h4`, or a heading and the text under it, through the heading's `id`. `snippet` is a line of that text around the first word found, its parts marking each word searched for.

A query needs all its words, each found as a word or the start of one, with case and accents ignored. A word is a run of letters and digits, so in Chinese or Japanese, written without spaces, a query finds a run only by its start. A word in the page's title counts most, then one in a heading, then the text. The browser loads only the part of the index holding the words typed, then the texts of the best hits.

## What goes in

Each page is read from its `main`, or its `body` without one. Navigation, footers, scripts and anything marked `data-search="false"` stay out. So do pages behind a guard or refused by `requireGuards`, pages with `noindex`, and pages setting `search: false` in their `page`. `search: { weight: 0.5 }` makes a page's words count half as much, so its hits come after the others':

```kay
--- server
export const page = { prerender: true, search: { weight: 0.5 } }
---
h1 Changelog
```

With [locales](/guides/i18n), each locale gets its own index, and the search reads the one matching the page's language.

The index is written by `kay build`, so `kay dev` has none: run `kay build` then `kay start` to try it.

<ReadMore href="/llms/head#site-search">How sections are cut, how hits are scored and how the index is split are in the full reference.</ReadMore>
