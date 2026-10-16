---
title: Head and SEO
order: 8
description: Set each page's head, give the whole site its defaults, and let kay serve the sitemap, robots.txt and favicons.
---

A `head` block in a page, a layout or a static component sets tags in the document head. The page wins over its layouts, so its `title` and `meta` tags replace theirs.

```kay
--- server
import { findPost } from '../../posts'

const post = await findPost(ctx.params.slug) ?? ctx.notFound()
---
head
  title {post.title}
  meta(name="description" content={post.summary})
h1 {post.title}
```

## A title that follows live state

An island can have a `head` block too, holding a `title` and no other tag. The title follows what the island reads, so a page named after a room or a count in progress shows it.

```kay
---
const { room } = props<{ room: () => { name: string } | undefined }>()
---
head
  title {room()?.name ?? ''}
```

The server renders the first title, so a search engine and the first paint see it. The browser then updates it whenever the signal changes.

The title goes through `seo.titleTemplate`, as on the server. `title(raw)` skips the template. A title that reads empty shows the site's `seo.name`, and a missing value needs `?? ''`.

Following a link shows the next page's own title. Going back shows the island's title again once it hydrates.

<ReadMore href="/llms/head">Two islands setting a title, `hydrate="client"` and `persist` islands, and a `try` block that throws.</ReadMore>

## Attributes on `<html>`

An `html` tag in the `head` block sets attributes on `<html>`, such as a theme. The values can be static or come from server data.

The page's attributes win over its layouts', and `false` or `null` removes one. A `class` adds up instead: a page's `html.wide` under a layout's `html.dark` gives `class="dark wide"`.

```kay
--- server
const section = ctx.url.pathname.split('/')[1] || 'home'
---
head
  html(data-theme="light" data-section={section})
slot
```

kay sets `lang` and `dir` itself, from `lang` in kay.config.ts or the page's locale.

When a link swaps the page in, a theme your script changed, such as a dark mode toggle, stays. It takes the place of the next page's own `theme-color`.

## Site defaults

`site` and `seo` in `kay.config.ts` give every page a starting point. Any tag a layout or the page sets replaces it.

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  site: 'https://example.com',
  seo: {
    name: 'Example',
    titleTemplate: '%s | Example',
    description: 'What the site is',
    image: '/og.png',
    imageAlt: 'The Example shop front',
    twitter: '@example',
  },
})
```

With `site` set, every page gets a canonical link, `og:title`, `og:description`, `og:url` and `twitter:card`.

A home page can put the name first with `title(raw) Example, the shop for kay`, which skips the template.

A site with several languages gives `name`, `titleTemplate`, `description`, `image`, `imageAlt` and `locale` one text per locale. No page then sets a tag to get its own language's.

```ts
seo: {
  name: { en: 'Example', fr: 'Exemple' },
  description: { en: 'What the site is', fr: 'Ce qu\'est le site' },
},
```

A locale the record leaves out reads the default locale's. `kay check` measures each description against the length search results show.

The web manifest follows the locale. A locale with its own `name` or `description` links `/manifest.fr.webmanifest`. A locale reading the default text links `/manifest.webmanifest`.

<Callout type="tip">

Without `site` in the config, kay reads it from `SITE_URL`, else `ORIGIN`. A value that is not a plain http(s) origin is ignored. One build then serves each host it is deployed to.

</Callout>

Any other tag every page carries, such as a script of the site's own, goes in the config's `head`.

```ts
export default defineConfig({
  head: [{ tag: 'script', props: { src: '/stats.js', defer: true } }],
})
```

An analytics script that needs the visitor's consent goes in an island instead, loaded once they agreed. [Privacy](/guides/privacy) shows how.

<ReadMore href="/llms/sitemap-search-fonts">The manifest of a locale, a site that serves its own manifest, and the OpenAPI title.</ReadMore>

## Social card

`seo.image` is the default `og:image`. A page can set its own, drawn from its title with `shareCard()` from `kay/image`.

```kay
---
import { shareCard } from 'kay/image'
---
head
  meta(property="og:image" content={shareCard({ title: post.title })})
```

`shareCard` needs a font listed in `fonts`.

`images.card` in `kay.config.ts` sets the card's `background`, text `color` and `font`. It also takes a square `logo`, drawn at the top left: `images: { card: { logo: 'src/logo.svg' } }`. `kay check` reports a logo that is missing, not square or not an image it can draw.

## Sitemap and robots.txt

A project with a `site` serves `/sitemap.xml` and `/robots.txt`. The robots file allows every crawler and points at the sitemap.

The sitemap lists every page without params. A page with params lists its own URLs, from `sitemap` or else its `prerender` list.

```kay
--- server
import { listPosts } from '../../data'

export const page = {
  sitemap: async () => (await listPosts()).map(post => ({ slug: post.slug })),
}
---
```

`noindex: true` in a page's `page` object keeps a page out of search engines and the sitemap.

A file of the same name in `public/` replaces either generated file.

## Favicon

`favicon` names a square image of 512 pixels or more, or a square SVG such as `src/favicon.svg`. kay draws every icon from it. Turn any text in an SVG into paths.

kay serves the sizes browsers ask for, plus a web manifest, and links them from every page. A site that names none shows kay's kingfisher on a navy tile.

The manifest also takes the installed app's `startUrl`, `scope`, `orientation`, `shortcuts` and a `maskable` image for launchers that crop icons.

```ts
export default defineConfig({
  favicon: 'src/favicon.png',
  manifest: {
    shortName: 'Ex',
    themeColor: '#1e1e2e',
    display: 'standalone',
    maskable: 'src/favicon-maskable.png',
    shortcuts: [{ name: 'New note', url: '/notes/new' }],
  },
})
```

## Offline

`offline: true` turns on a service worker. It keeps the build's scripts, stylesheets and fonts, the pages listed in `pages` and the prerendered pages no guard covers. An installed site then still opens without a connection.

```ts
export default defineConfig({
  offline: { pages: ['/', '/menu'], fallback: '/offline' },
})
```

Pages come from the network first. A kept copy answers only when the network fails, then the `fallback` page. Actions and API routes always go to the network.

`kay dev` registers no worker.

## JSON-LD

`jsonLd()` from `kay/seo` writes structured data from typed data. It adds the schema.org `@context`.

```kay
---
import { jsonLd } from 'kay/seo'
---
head
  script(type="application/ld+json")
    | {jsonLd({ '@type': 'LocalBusiness', 'name': 'Example' })}
```

`seo.jsonLd` in the config takes the same data for every page.

<ReadMore href="/llms/sitemap-search-fonts">Breadcrumb lists, `siteUrl()`, what the offline worker keeps and skips, and every favicon and manifest option.</ReadMore>
