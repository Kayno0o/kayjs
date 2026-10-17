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

`seo.themeColor` colours the browser around every page. Give it a pair to follow the visitor's colour scheme:

```ts
export default {
  seo: { themeColor: { light: '#ffffff', dark: '#111111' } },
}
```

A single colour works too, and `manifest.themeColor` is the fallback. A page that writes its own `theme-color` meta replaces the site's one for the same `media`.

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

Pass `image` to draw the title over a picture, which covers the card and fades into the background below the title. It can be an imported PNG, JPEG, WebP, GIF or AVIF, or an imported SVG such as a banner kept in the repo: the SVG is drawn to cover the card, cut in the middle if its shape differs, and `kay build` keeps that drawing for an executable. Turn any text in the SVG into paths, as kay draws it without fonts. An SVG from `images.dirs` or `images.remote` is refused.

To use a photo as the card, `shareImage(hero)` from `kay/image` is the URL of an imported image cut to the 1200x630 card, enlarged when smaller. It takes an image from `images.dirs` or `images.remote` too.

```kay
---
import { shareImage } from 'kay/image'
import hero from '../hero.jpg'
---
head
  meta(property="og:image" content={shareImage(hero)})
```

`images.card` in `kay.config.ts` sets the card's `background`, text `color` and `font`, as `{ family: 'Inter', weight: 800 }`. It also takes a square `logo`, drawn at the top left: `images: { card: { logo: 'src/logo.svg' } }`. `kay check` reports a logo that is missing, not square or not an image it can draw.

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

`lastmod` tells crawlers when a URL last changed. It takes a date, a date string, or a function that gets the params of each URL:

```kay
--- server
import { findPost, listPosts } from '../../data'

export const page = {
  sitemap: async () => (await listPosts()).map(post => ({ slug: post.slug })),
  lastmod: async ({ slug }) => (await findPost(slug))?.updatedAt,
}
---
```

A URL the function returns nothing or `null` for is listed without one. A value that is no date stops the sitemap with an error naming the page. Only a page's own `lastmod` counts, not a layout's.

`noindex: true` in a page's `page` object keeps a page out of search engines and the sitemap. In a layout it does the same for every page under it, and a page's own `noindex: false` takes it back. A layout takes `search` and `revalidate` the same way.

Add rules to the robots file with `robots` in `kay.config.ts`:

```ts
export default {
  robots: { disallow: ['/admin'], allow: ['/admin/login'] },
}
```

Write each path without the `base` and the locale. kay lists it for every locale of the site, under the mount point, and a site with a domain per locale lists it on each host. A pattern starting with `*`, such as `*.pdf$`, is written as it is. `robots: false` serves no robots file.

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

Pages come from the network first. A kept copy answers only when the network fails, then the `fallback` page. Without a `fallback`, kay writes a plain page that says the page needs a connection, with status 503.

`pages` and `fallback` are paths of the site. The worker also keeps the other files the build serves, such as images, as they are first loaded, so islands hydrate offline.

It leaves out what should never be stale. Actions, API routes and everything under `/_kay/` go to the network, and so does any request that is not a GET, goes to another site or asks for a range, as a video does. A response is kept only as a full 200, and never when it says `private` or `no-store`.

Each deploy changes the worker, which takes over at once and drops the old cache. Nothing needs clearing by hand. The server warns past 100 prerendered pages, since each visitor downloads them on every deploy.

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
