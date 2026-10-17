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

`kay build` then indexes the text of every page it renders, including the pages of your content collections. `kay build --static` writes the index with the rest of the site.

A page rendered per request, with no `prerender`, is not in it.

## A search box

`searchResults` follows a signal holding the query and gives the hits of the latest one.

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

Each hit links a section of a page. A section is the text above its first `h2`, `h3` or `h4`, or a heading and the text under it. The link goes through the heading's `id`.

A page opened from a hit marks those words in the section. It scrolls to the first one if it is out of view. You wire nothing: the hit's `href` carries the words, so it works with kay's palette and with your own links.

The page needs kay's client, which any island brings. In a browser without the CSS Custom Highlight API, the page only scrolls to the heading. To change the look, style `::highlight(kay-search)`.

The words stay in the URL, where analytics see them, and a refresh marks them again.

`snippet` is a line of that text around the first word found. Its parts mark each word searched for.

A query needs all its words. Each is found as a word or the start of one, with case and accents ignored.

Each hit has `page`, `heading`, `headingParts`, `href`, `snippet`, `more` and a `score`. `heading` is `undefined` for the text above the first heading. `href` is the page's path, then `?kay_q=` with the words searched for, then the heading's anchor. `headingParts` is the heading in parts, as `snippet` is, so you can mark the words found in it too. `more` counts the words found in the text past the snippet.

`searchResults(query, { limit })` returns at most `limit` hits, 20 by default. `searchSite(query, options)` from `kay` is the same search as a promise, for a script. Both return no hits on the server.

### How hits are ranked

A section is scored for each word of the query, and the scores add up. A word in the page's title counts most, then one in a heading, then one in the text.

In a title or a heading, a word counts a little more when it makes up more of it. A search for `mcp` finds a heading `kay mcp` before a long one that names MCP among ten other words.

A word found whole counts more than one that only starts a longer word, and the less of that word you typed, the less it counts: `island` finds a page titled Islands nearly as well as a heading naming an island.

A page whose sections often hold a word is about it, so a match in the text of its sections counts a little more. This lifts the guide about a topic above a page naming it once, but never above a heading or a title naming it. A page's `weight` multiplies its scores.

Hits come best first. Two with the same score keep their order in the site.

The browser loads only the part of the index holding the words typed, then the texts of the best hits.

### Words

A word is a run of letters and digits, with case and accents ignored. A one-letter word is dropped from the query and the index.

Chinese and Japanese have no spaces between words, so a whole run of characters is one word. A query finds a run only by its start. Searching for the first characters of a phrase finds it, and searching for characters from its middle does not.

A zero-width space parts two words, as it does in Thai. Soft hyphens and zero-width joiners join the word they split, in the pages and in the query.

<ReadMore href="/llms/sitemap-search-fonts#site-search">How the index is split and written, and the `lang` option, are in the full reference.</ReadMore>

## What goes in

Each page is read from its `main`, or its `body` without one. Navigation, footers, scripts, buttons outside a heading and anything marked `data-search="false"` stay out.

So do pages behind a guard or refused by `requireGuards`, pages with `noindex`, and pages setting `search: false` in their `page`.

Set `search: { weight: 0.5 }` to make a page's words count half as much, so its hits come after the others'.

```kay
--- server
export const page = { prerender: true, search: { weight: 0.5 } }
---
h1 Changelog
```

A route with params serves many pages, so `search` can also be a function of the params of each page, as `prerender` lists them. It returns `false`, a `weight`, or nothing for a page that keeps the default weight of 1, whatever a layout says. A function in a layout gets the params of each page rendered under it. A weight is a number of 0 or more, and anything else stops the build.

```kay
--- server
export const page = {
  prerender: [{ slug: 'intro' }, { slug: 'changelog' }, { slug: 'draft' }],
  search: params => params.slug === 'draft' ? false : params.slug === 'changelog' ? { weight: 0.3 } : undefined,
}

const { slug } = ctx.params
---
h1 {slug}
```

With [locales](/guides/i18n), each locale gets its own index, and the search reads the one matching the page's language.

The index is written by `kay build`, so `kay dev` has none. Run `kay build` then `kay start` to try it.

<ReadMore href="/llms/sitemap-search-fonts#site-search">How sections are cut, how hits are scored and how the index is split are in the full reference.</ReadMore>
