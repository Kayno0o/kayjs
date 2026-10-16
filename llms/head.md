# Head and site metadata

## Common tasks

### Set a page's title and description

A `head` block at the top of a page holds its `title` and `meta` tags, written from server data if need be:

```kay
--- server
import { findTodo } from '../../data'

const todo = await findTodo(Number(ctx.params.id)) ?? ctx.notFound()
---
head
  title {todo.title} | Todos
  meta(name="description" content={`Todo #${todo.id}`})
h1 {todo.title}
```

### Follow live state in the page title

An island's `head` block holds a `title` and nothing else, and the title follows what it reads, wrapped in `seo.titleTemplate` as on the server:

```kay
---
const { room } = props<{ room: () => { name: string } | undefined }>()
---
head
  title {room()?.name ?? ''}
```

The server renders the first title, so a crawler and the first paint see it; the browser then updates it whenever the signal changes.

### Give every page a title template and a social card

`site` and `seo` in `kay.config.ts` start every page's head, and a tag a layout or the page sets replaces them:

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
  },
})
```

### Put the site name first on the home page

`title(raw)` is written as it is, outside `titleTemplate`:

```kay
head
  title(raw) Example, the shop for kay
h1 Welcome
```

### Add a script or a tag to every page

`head` in `kay.config.ts` adds tags to every page's head:

```ts
export default defineConfig({
  head: [
    { tag: 'script', props: { src: '/stats.js', defer: true } },
    { tag: 'meta', props: { name: 'color-scheme', content: 'light dark' } },
  ],
})
```

### Describe a page with JSON-LD and breadcrumbs

`jsonLd()` and `breadcrumbList()` from `kay/seo` write the data in a server fence, and a `script` in the `head` block holds it:

```kay
--- server
import { breadcrumbList, jsonLd } from 'kay/seo'

const trail = jsonLd(breadcrumbList([{ name: 'Home', path: '/' }, { name: 'Services', path: '/services' }]))
---
head
  script(type="application/ld+json") {trail}
h1 Services
```

### Keep a page out of search engines

`noindex: true` in the `page` object adds a robots meta and leaves the page out of the sitemap:

```kay
--- server
export const page = { noindex: true }
---
h1 Legal notice
```

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

## Reference

### Head

```kay
--- server
import { findTodo } from '../../data'

const todo = await findTodo(Number(ctx.params.id)) ?? ctx.notFound()
---
head
  title {todo.title} | Todos
  meta(name="description" content={`Todo #${todo.id}`})
h1 {todo.title}
```

- One `head` block per template, at its top level, in a page, a layout or a component.
- The page wins over its layouts: one `title`, and one `meta` per `name`, `property` or `http-equiv`.
- A `link` is one per `rel` and `href`.
- Head elements hold text only.
- Their attributes take no handlers, a `javascript:` URL goes out as `unsafe:javascript:...`, and a script's text cannot end it or open a comment, whatever the server data in it.
- The default charset and viewport tags can be replaced the same way.
- A `link(rel="canonical")` is one per page, the page's replacing its layouts'.
- `html(data-theme="light")` sets attributes on `<html>`, static or from server data, from the `head` block only.
- An `html` attribute is one per name, a layout's over the layouts around it and the page's over all, `false` or `null` taking one off.
- `class` is the exception: its tokens add up across the layouts and the page, each once.
- `html.dark` in a layout and `html.wide` in its page give `class="dark wide"`, and a page cannot take off a layout's class.
- No event handler is attached to `html`.
- `lang` and `dir` are kay's, from `lang` in kay.config.ts or the locale.
- An island's `head` holds a `title` only, any other tag being the page's to set, and `title(raw)` skips `seo.titleTemplate` there too.
- While an island's title reads empty, the page shows `seo.name` as the server does.
- Two islands on a page both setting a title: the one last in the page shows, as the server renders it, hydrated or not and whichever hydrated last; a change in the others leaves it. An island rendered in the browser alone is not counted.
- A `try` block that throws on the server takes back what its components set in the head, an island's title included, so the page never serves a title or tag from a block it replaced with `catch`.
- A title reads `undefined` for a missing value, so write `?? ''` where it may be missing.
- An island rendered in the browser alone (`hydrate="client"`) has no server render to take the template from, so it sets its title as written.
- An island kept across navigation (`persist`) shows the next page's title at a swap, as its layout's would, and sets its own again when a signal it reads changes.
- Navigating to another page shows that page's own title, and coming back shows the island's again once it hydrates; a page with no island title is as the server served it.
- Only a site with such an island ships the code for it, a few hundred bytes.
- A page swap changes only what the server sets differently for the next page, and only where a script left it as the server set it, so a theme a toggle changed stays.
- A `class` changes token by token on a page swap, a token the server set being the server's.
- The head opens with the charset and viewport, then the stylesheets and `style` elements of `head` blocks and of `fonts`, then the stylesheets of the components, which win a tie with them, then everything else, so the first paint waits on no other tag.

### Site defaults and social cards

`site` and `seo` in `kay.config.ts` give every page's head a starting point, which any tag a layout or the page sets replaces:

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
    locale: 'en_GB',
    jsonLd: [{
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      'name': 'Example',
      'url': 'https://example.com',
    }],
  },
})
```

- With `i18n`, `name`, `titleTemplate`, `description`, `image`, `imageAlt` and `locale` each take a string or a record of one string per locale, `description: { en: 'What the site is', fr: 'Ce qu\'est le site' }`, so no page sets a tag for its language's; a locale the record lacks reads the default locale's. The head lints check every text, and the manifest and share cards read the default locale's `name` and `description`.
- `head` adds tags to every page's head, written as a `head` block compiles them, a tag's text as `children`: `head: [{ tag: 'script', props: { src: '/stats.js', defer: true } }, { tag: 'meta', props: { name: 'color-scheme', content: 'light dark' } }]`. An analytics script that needs the visitor's consent loads from an island once they agreed (see [Privacy](privacy.md)).
- A layout or the page setting a tag of the same identity replaces one of those.
- An inline script or style among them is let through by the content security policy, its hash added.
- `site` is an origin, nothing after the host.
- Left out of kay.config.ts, `site` is read from `SITE_URL`, so one build serves each host it is deployed to: production, a preview, the e2e server.
- `kay build` does not report `missing-site` for such a server build; the server warns once at boot when `seo` is set and `SITE_URL` is not.
- Prerendered pages name the site `kay build` ran for; a server running for another renders each again on its first request, with a warning at boot, so set `site` when building where it is known.
- With no site at build, a page reading it through `siteUrl()` or `siteOrigin()` prerenders all the same, and the server renders it again before serving it; `kay build --static` refuses it.
- Each page answering 200 gets `link(rel="canonical")` at `site` plus its path, query left out; an error page gets none.
- `name` is the title of a page that sets none, unwrapped, and `og:site_name`.
- `titleTemplate` wraps a title a layout or the page sets: `title About` renders `About | Example`.
- A `title(raw)` in a `head` block is written as it is, outside `titleTemplate`, so a home page can put the name first: `title(raw) Example, the shop for kay`.
- `raw` itself is not written, `raw={condition}` applies when it holds, and a page's plain title still replaces a layout's raw one.
- `og:title`, `og:description` and `og:url` repeat the page's own title (unwrapped), description and canonical link unless it sets them.
- `twitter:card` is `summary_large_image` once there is an `og:image`.
- A canonical link or an `og:image` and `twitter:image` written as a path, `/og.png` or an imported asset's URL, is made absolute against `site`.
- `og:type` is `website`.
- An `og:image` written as the path of a public file, an imported image or a `shareImage()` or `shareCard()` card gets `og:image:width` and `og:image:height`, read from the file, so a network draws the card without fetching the image first.
- `imageAlt` gives `og:image:alt` beside `seo.image`, and `twitter:image:alt` repeats whatever `og:image:alt` is.
- A page setting its own `og:image` keeps neither the size nor the alt text of the site's image: it sets `meta(property="og:image:alt" content="...")` beside it.
- JSON-LD goes in a `head` block as a `script(type="application/ld+json")` holding its text, which `jsonLd()` from `kay/seo` writes from typed data in a server fence: `const place = jsonLd({ '@type': 'LocalBusiness', 'name': shop.name })`, then `script(type="application/ld+json") {place}`.
- `jsonLd()` adds the schema.org `@context` unless the data names its own, and takes a list as one `@graph`.
- The type checks `@type` only, the rest being schema.org's vocabulary.
- Any `<` in a JSON script is written `\u003c`, so a value holding `</script>` cannot end it.
- `seo.jsonLd` takes the same data.
- `breadcrumbList(trail)` from `kay/seo` gives a page's breadcrumb trail as the `BreadcrumbList` search engines read, home first: `jsonLd(breadcrumbList([{ name: 'Home', path: '/' }, { name: 'Services', path: '/services' }]))`, each path made absolute by `siteUrl`.
- `siteUrl('/contact')` from `kay/seo` gives an absolute URL of the site, `https://example.com/contact`, from `site` and `base` in kay.config.ts, for a mail, a share link or structured data.
- `siteUrl` gives a path ending with a slash under `trailingSlash: 'always'`, as canonical links do.
- `siteUrl` throws on the server when `site` is not set, prerendered pages included, and in the browser reads the page's own origin.
- `siteUrl()` is the home page's, and `siteOrigin()` from `kay/seo` the origin alone, `https://example.com`, without `base`.
- The site is the one the last `pages()` or build of the process read, one site per process.
- `noindex: true` in the `page` object a page's server fence exports asks search engines to leave it out, `<meta name="robots" content="noindex">` in its head, a `robots` tag of its own still winning.
- `noindex: true` also leaves the page out of the sitemap, as legal pages often are.
- Without `site` and `seo`, a page's head holds only the tags it and its layouts set.

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
- `preload: true` fetches it with the page instead, so text is likelier to paint in it first, but on a slow phone a preload shares the link with the stylesheet and holds back the first paint: dropping its two preloads painted one site about 190 ms sooner on a throttled phone, with no layout shift to speak of.
- Preload a face only when text painting in it first matters more than painting sooner.
