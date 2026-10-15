---
title: Head and SEO
order: 8
description: Set each page's head, give the whole site its defaults, and let kay serve the sitemap, robots.txt and favicons.
---

A `head` block in a page, a layout or a static component sets tags in the document head. The page wins over its layouts: its `title` and its `meta` tags replace theirs.

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

## Attributes on `<html>`

An `html` tag in the `head` block sets attributes on `<html>`, such as a theme, from static values or server data. The page's attributes win over its layouts', and `false` or `null` removes one. A `class` adds up instead: a page's `html.wide` under a layout's `html.dark` gives `class="dark wide"`.

```kay
--- server
const section = ctx.url.pathname.split('/')[1] || 'home'
---
head
  html(data-theme="light" data-section={section})
slot
```

`lang` and `dir` are set by kay, from `lang` in kay.config.ts or the page's locale. When a link swaps the page in, a theme your script changed, such as a dark mode toggle, stays, in place of the next page's own `theme-color`.

## Site defaults

`site` and `seo` in `kay.config.ts` give every page a starting point, which any tag a layout or the page sets replaces:

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

With `site` set, every page gets a canonical link, `og:title`, `og:description`, `og:url` and `twitter:card`. A home page can put the name first with `title(raw) Example, the shop for kay`, which skips the template.

<Callout type="tip">

Without `site` in the config, kay reads it from `SITE_URL`, so one build serves each host it is deployed to.

</Callout>

Any other tag every page carries, such as a script of the site's own, goes in `head`. An analytics script that needs the visitor's consent goes in an island instead, loaded once they agreed, as [Privacy](/guides/privacy) shows:

```ts
export default defineConfig({
  head: [{ tag: 'script', props: { src: '/stats.js', defer: true } }],
})
```

## Social card

`seo.image` is the default `og:image`. A page can set its own, drawn from its title with `shareCard()` from `kay/image`:

```kay
---
import { shareCard } from 'kay/image'
---
head
  meta(property="og:image" content={shareCard({ title: post.title })})
```

`shareCard` needs a font listed in `fonts`. `images.card` in `kay.config.ts` sets the card's `background`, text `color` and `font`, and a square `logo`, an SVG or an image, drawn at its top left: `images: { card: { logo: 'src/logo.svg' } }`. `kay check` reports a logo that is missing, not square or not an image it can draw.

## Sitemap and robots.txt

A project with a `site` serves `/sitemap.xml` and `/robots.txt`, which allows every crawler and points at the sitemap. The sitemap lists every page without params. A page with params lists its own, from `sitemap` or else its `prerender` list:

```kay
--- server
import { listPosts } from '../../data'

export const page = {
  sitemap: async () => (await listPosts()).map(post => ({ slug: post.slug })),
}
---
```

`noindex: true` in a page's `page` object keeps a page out of search engines and the sitemap. A file of the same name in `public/` replaces either generated one.

## Favicon

`favicon` names a square image of 512 pixels or more, or a square SVG (`favicon: 'src/favicon.svg'`), from which kay draws every icon. Turn any text in an SVG into paths. kay serves the sizes browsers ask for and a web manifest, and links them from every page. A site that names none shows kay's kingfisher on a navy tile. The manifest also takes the installed app's `startUrl`, `scope`, `orientation`, `shortcuts` and a `maskable` image for launchers that crop icons.

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

`offline: true` turns on a service worker. It keeps the build's scripts, stylesheets and fonts, the pages listed in `pages` and the prerendered pages no guard covers, so an installed site still opens without a connection:

```ts
export default defineConfig({
  offline: { pages: ['/', '/menu'], fallback: '/offline' },
})
```

Pages are fetched from the network first, and a kept copy answers only when the network fails, then the `fallback` page. Actions and API routes always go to the network. `kay dev` registers no worker.

## JSON-LD

`jsonLd()` from `kay/seo` writes structured data from typed data, adding the schema.org `@context`:

```kay
---
import { jsonLd } from 'kay/seo'
---
head
  script(type="application/ld+json")
    | {jsonLd({ '@type': 'LocalBusiness', 'name': 'Example' })}
```

`seo.jsonLd` in the config takes the same data for every page.

<ReadMore href="/llms/head">Raw titles, breadcrumb lists, `siteUrl()`, what the offline worker keeps and skips, and every favicon and manifest option are in the full head reference.</ReadMore>
