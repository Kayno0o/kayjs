# Sitemap, favicon, offline, search and fonts

## Common tasks

### List a page's params in the sitemap

A page with params lists them with `sitemap`, which takes what `prerender` takes:

```kay
--- server
import { findPost, listPosts } from '../../data'

export const page = {
  sitemap: async () => (await listPosts()).map(post => ({ slug: post.slug })),
}

const post = await findPost(ctx.params.slug) ?? ctx.notFound()
---
h1 {post.title}
```

### Set a favicon and make the site installable

`favicon` names a square image, from which kay makes every icon and the web manifest:

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  favicon: 'src/favicon.png',
  seo: { name: 'Example' },
  manifest: { themeColor: '#1e1e2e', display: 'standalone' },
})
```

### Make the site work offline

`offline: true` turns on a service worker keeping the site's files and some of its pages:

```ts
export default defineConfig({
  offline: { pages: ['/', '/menu'], fallback: '/offline' },
})
```

### Add a search box

`search: true` in `kay.config.ts` has `kay build` index the pages, and `searchResults(query)` follows a signal holding the query:

```kay
---
import { searchResults, signal } from 'kay'

const query = signal('')
const { hits } = searchResults(query)
---
input(type="search" aria-label="Search" bind:value={query})
ul
  for hit of hits() key={hit.href}
    li
      a(href={hit.href}) {hit.page}
```

### Self-host a font

`fonts` in `kay.config.ts` serves a font file or an installed Fontsource package, and a stylesheet names its family:

```ts
export default defineConfig({
  fonts: [{ fontsource: '@fontsource-variable/inter' }],
})
```

The text shows in a fallback sized to the font until it loads, so the layout does not shift as it swaps in.

## Reference

### Sitemap and robots.txt

A project with a `site` serves `/sitemap.xml` and `/robots.txt`, which allows every crawler and points at the sitemap; a file of the same name in `public/` replaces either. The sitemap lists:

- every page without params, unless its `page` sets `sitemap: false` or `noindex: true`;
- for a page with params, the ones its `sitemap` key lists, else the ones its `prerender` key lists, else none. `sitemap` takes what `prerender` takes: `true`, `false`, a content collection, a list of params or a function returning one;
- a page behind a guard only when its `sitemap` key lists it.

```kay
--- server
import { findPost, listPosts } from '../../data'

export const page = {
  sitemap: async () => (await listPosts()).map(post => ({ slug: post.slug })),
}

const post = await findPost(ctx.params.slug) ?? ctx.notFound()
---
h1 {post.title}
```

In production the sitemap is built on the first request and kept for an hour; development builds it per request.

### Favicon and web manifest

`favicon` in `kay.config.ts` names a square image relative to the root, 512 pixels wide or more for sharp icons (a smaller one is enlarged, with a warning naming it): `favicon: 'src/favicon.png'`.

- kay serves it as `/favicon.ico` (16, 32 and 48 pixels), `/apple-touch-icon.png` (180), `/icon-192.png` and `/icon-512.png`, plus `/manifest.webmanifest`, and links them from every page.
- `kay build` writes them, which a server serving that build reads; any other, development and `testSite` included, makes them from the image on first request, so an older build never shows a changed favicon.
- Each path a public file or a page already serves is left to it.
- `favicon: { image: 'src/favicon.png', svg: 'src/favicon.svg' }` adds an SVG of it, served as `/favicon.svg` as it is and linked after the ICO, so browsers drawing SVG icons use it, sharp at any size; the icons are still made from `image`.
- A square SVG named alone, `favicon: 'src/favicon.svg'`, is both: kay draws every icon from it at its own size and serves it as `/favicon.svg`, linked after the ICO.
- Its `svg` tag needs a `viewBox`, or a `width` and `height` that are not percentages.
- Text in it draws without fonts, so as nothing, which `kay build` and `kay check` warn of: turn text into paths.
- One with no size, not square or not an SVG fails `kay build` and `kay check`, naming the file.
- An executable made with `kay build --compile` serves the icons the build drew and carries nothing for drawing SVG.
- `manifest.maskable` can be an SVG too.
- A project that names none gets kay's own mark, a kingfisher on a navy tile, its SVG included.
- `favicon: false` turns the favicon, its links and the manifest off.

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  favicon: 'src/favicon.png',
  seo: { name: 'Example' },
  manifest: {
    shortName: 'Ex',
    themeColor: '#1e1e2e',
    backgroundColor: '#11111b',
    display: 'standalone',
    orientation: 'any',
    startUrl: '/notes',
    scope: '/',
    maskable: 'src/favicon-maskable.png',
    shortcuts: [{ name: 'New note', url: '/notes/new' }],
  },
})
```

- The manifest is named after `seo.name`, `shortName` defaulting to it, and described by `seo.description`.
- A `name` or `description` written per locale gives each locale reading a text of its own a manifest of its own, `/manifest.fr.webmanifest` beside the default locale's `/manifest.webmanifest`, which that locale's pages link; a locale reading the default locale's text links the default's, and a site writing them once serves one. A site serving its own `/manifest.webmanifest`, a public file or an endpoint, keeps it: kay then serves and links no manifest of a locale. An explicit `shortName` and every path in the manifest, `startUrl` and `scope` included, are the same in all of them, `short_name` otherwise following the locale's `name`.
- `themeColor` is also every page's `theme-color`, `favicon: false` included.
- `startUrl` is the page the installed app opens, `scope` by default, else `/`, and `scope` the paths it keeps in its window.
- `startUrl`, `scope` and each shortcut's `url` (`name`, `shortName`, `description`) are paths of the site, put under `base`.
- One not starting with a single `/`, or a start page or shortcut outside `scope`, which browsers would ignore, stops the server as it boots.
- `maskable` names a square image whose subject sits inside the middle 80%, which a launcher may crop to a circle or a squircle.
- kay serves `maskable` as `/icon-maskable-192.png` and `/icon-maskable-512.png`, listed in the manifest with `purpose: "maskable"`, as it serves the favicon.

### Offline

`offline: true` in `kay.config.ts` turns on a service worker, which keeps the site's files and some of its pages for a visitor who lost their connection or opens the installed site with none:

```ts
export default defineConfig({
  offline: { pages: ['/', '/menu'], fallback: '/offline' },
})
```

- Every page carries a script registering `/sw.js`, under the site's `base`, once it has loaded; the policy allows it by hash as kay's other inline scripts.
- Off, nothing is added to a page.
- On its install the worker fetches the build's scripts, stylesheets and fonts, every page `pages` lists, as paths of the site, every prerendered page no guard covers without it, and the `fallback` page.
- The server warns past 100 prerendered pages, since each visitor downloads them on every deploy.
- The build's other files, such as images, are kept as they are first loaded.
- It answers the build's files from what it keeps, so islands hydrate offline.
- A page is fetched from the network first, a kept page's copy refreshed each time, unless its response says `private` or `no-store`.
- Offline, the kept copy answers, then the `fallback` page, then a plain page kay writes saying the page needs a connection, with status 503.
- A page swap fetches through it too, so following a link between kept pages works offline.
- Actions, API routes and every other path under `/_kay/` always go to the network, as does any request other than GET, to another site, or for a range, as a video or an audio file asks for.
- Only a full 200 for the URL asked is kept, never one a redirect led to.
- `/_kay/env.js` is fetched from the network first and kept for offline islands.
- The worker's cache is named after the build and the prerendered pages, so a deploy changes `/sw.js`, which the browser checks as a page loads.
- The new worker takes over at once, drops the old cache, and the page swap goes on fetching through it.
- Nothing has to be cleared by hand.
- `kay dev` adds no script, and its `/sw.js` removes a worker a production run left on the same origin.
- Turning `offline` off does the same for visitors who had it.
- A public file or a page at `/sw.js` wins over kay's.

### Site search

`search: true` in `kay.config.ts` has `kay build` index the text of every page it renders, `kay build --static` included, and an island searches it in the browser, with no service: `searchResults(query)` from `kay` follows a signal holding the query, its `hits()` those of the latest query, whichever answers first, with `loading()` and `error()` beside them.

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

- The search's code loads with the first query holding a word, so an island that may search adds nothing to a page until then.
- kayjs-ui's `CommandPalette` takes `siteSearch` for this box ready made, its hits after the palette's own entries.
- The index holds the pages the build renders, those with `prerender`, a content collection's pages among them; a page rendered per request is not in it.
- A page a guard covers, or that `requireGuards` refuses, one with `noindex`, and one setting `search: false` in its `page` are left out.
- `search: { weight: 0.5 }` makes a page's words count half as much, its hits after the others'.
- Each page is read from its `main`, or its `body` without one, leaving out `nav`, `footer`, `script`, `style`, `svg` and any element marked `data-search="false"`.
- It is split into sections: the text above its first `h2` to `h4`, then each of those with the text under it, linked by the heading's `id`.
- A link inside the heading to itself is left out when it shows only `#`, `¶`, `§` or nothing visible, and the heading's own text kept as written, `C#` included.
- Soft hyphens, zero-width joiners and non-joiners join the word they split, in the pages and the query alike, while a zero-width space parts two words, as in Thai.
- A section is titled by the page's `h1`, or its `title` without one, and each `href` ends in a slash under `trailingSlash: 'always'`.
- A query needs every word it holds, found as a word or the start of one, with case and accents ignored and words of one letter dropped.
- A word is a run of letters and digits, so a language written without spaces, such as Chinese or Japanese, is indexed by whole runs: a query finds such a run only by its start.
- A word in the page's title counts most, then in a heading, then in the text.
- Each hit has `page`, `heading` (undefined above the first heading), `href`, the page's path with the heading's anchor, `snippet`, a line of text around the first word found split into parts marking each word searched for, and `score`.
- `{ limit }` returns at most that many hits, 20 by default.
- `searchSite(query, options)` from `kay` is the same search as a promise, for a script of its own.
- With `i18n`, each locale gets its own index, and the search reads the one matching the page's `lang`; `{ lang }` picks another.
- The index is split by the first letters of its words, so a query loads only the files of the words it starts, then the texts of its best hits.
- It is written under `/_kay/search/`, in a directory named by its content, and `/_kay/search.json`, which names it, is revalidated on every load.
- Both return no hits on the server, and fail when the index cannot load, as under `kay dev`, which writes none: `kay build` then `kay start` serves it.

### Fonts

`fonts` in `kay.config.ts` self-hosts font files: each is served as a content-named asset, declared by `@font-face` rules in a `<style>` of every page's head, which spares the first paint a request of their own at the cost of a few hundred bytes per face in every page, and preloaded only with `preload: true`.

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  fonts: [
    {
      family: 'Inter',
      src: '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
      weight: '100 900',
      preload: true,
    },
    { family: 'Lora', src: 'src/fonts/lora-italic.woff2', style: 'italic' },
  ],
})
```

- An installed Fontsource package is listed once, its family name and files read from it: `{ fontsource: '@fontsource/open-sans', weights: [400, 600, 700], styles: ['normal', 'italic'] }` declares a face per weight and style, and `{ fontsource: '@fontsource-variable/inter' }` one per style spanning every weight, with no `weights`.
- `preload: true` on a Fontsource entry preloads each face it declares, as on a font: give it an entry of one subset.
- Each style lists the same weights, so an italic of one weight alone, `italic` at 400 beside normal at 400, 600 and 700, is a second entry: `{ fontsource: '@fontsource/open-sans', weights: [400], styles: ['italic'] }`.
- The family is the package's own name, `Figtree` for `@fontsource-variable/figtree`, not the `Figtree Variable` its stylesheet names.
- `subset` defaults to the package's own, `latin` for most.
- Several, `subset: ['latin', 'latin-ext']`, declare each face once per subset with its `unicode-range`, read from the package, so a page loads only the files its text needs.
- `styles` defaults to `['normal']`, and `display` applies to every face.
- A weight, style or subset the package lacks stops the build, naming the ones it has.
- A face to preload is written as a file entry.
- `src` is a `.woff2`, `.woff`, `.ttf` or `.otf` file relative to the root, or a file of an installed package.
- `weight` defaults to 400, or takes a range for a variable font; `style` to `normal`; `display` to `swap`; `unicodeRange` is passed through.
- A stylesheet names the family as it would any other: `font-family: Inter, system-ui, sans-serif`. With Tailwind, `@theme { --font-sans: Inter, system-ui, sans-serif; }`.
- A face loads once the page uses it, its text showing in the fallback font until then (`display: swap`).
- Each family gets a metric-matched fallback: kay reads the font's metrics, declares `"Inter Fallback"` as Arial, Times New Roman or Courier New resized with `size-adjust`, `ascent-override`, `descent-override` and `line-gap-override`, and lists it right after the family in the built stylesheets' `font-family` and `--*font*` custom properties and the family list of the `font` shorthand (its size may be `var()` or `calc()`), so the text barely moves when the font swaps in. A family whose files hold no Latin letters, or that kay cannot read, gets none. A `style` element in `head`, inline `style` attributes and stacks written in a script are left as written: list `"Inter Fallback"` there yourself.
- `preload: true` fetches it with the page instead, so text is likelier to paint in it first, but on a slow phone a preload shares the link with the stylesheet and holds back the first paint: dropping its two preloads painted one site about 190 ms sooner on a throttled phone, with no layout shift to speak of.
- Preload a face only when text painting in it first matters more than painting sooner.
