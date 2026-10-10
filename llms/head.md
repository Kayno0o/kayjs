# Head and site metadata

## Head

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

- One `head` block per template, at its top level, in a page, a layout or a static component; an island has none.
- The page wins over its layouts: one `title`, and one `meta` per `name`, `property` or `http-equiv`. A `link` is one per `rel` and `href`.
- Head elements hold text only. The default charset and viewport tags can be replaced the same way.
- A `link(rel="canonical")` is one per page, the page's replacing its layouts'.
- The head opens with the charset and viewport, then the stylesheets and `style` elements of `head` blocks and of `fonts`, then the stylesheets of the components, which win a tie with them, then everything else, so the first paint waits on no other tag.

## Site defaults and social cards

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
    jsonLd: [{ '@context': 'https://schema.org', '@type': 'WebSite', 'name': 'Example', 'url': 'https://example.com' }],
  },
})
```

- `site` is an origin, nothing after the host. Left out of kay.config.ts, it is read from `SITE_URL`, so one build serves each host it is deployed to: production, a preview, the e2e server. Prerendered pages name the site `kay build` ran for; a server running for another renders each again on its first request, with a warning at boot, so set `site` when building where it is known. With no site at build, a page reading it through `siteUrl()` or `siteOrigin()` prerenders all the same, the build warning that the server renders it again before serving it; `kay build --static` refuses it. Each page answering 200 gets `link(rel="canonical")` at `site` plus its path, query left out; an error page gets none.
- `name` is the title of a page that sets none, unwrapped, and `og:site_name`. `titleTemplate` wraps a title a layout or the page sets: `title About` renders `About | Example`. A `title(raw)` in a `head` block is written as it is, outside `titleTemplate`, so a home page can put the name first: `title(raw) Example, the shop for kay`; `raw` itself is not written, `raw={condition}` applies when it holds, and a page's plain title still replaces a layout's raw one.
- `og:title`, `og:description` and `og:url` repeat the page's own title (unwrapped), description and canonical link unless it sets them; `twitter:card` is `summary_large_image` once there is an `og:image`. A canonical link or an `og:image` and `twitter:image` written as a path, `/og.png` or an imported asset's URL, is made absolute against `site`. `og:type` is `website`.
- An `og:image` written as the path of a public file, an imported image or a `shareImage()` card gets `og:image:width` and `og:image:height`, read from the file, so a network draws the card without fetching the image first. `imageAlt` gives `og:image:alt` beside `seo.image`, and `twitter:image:alt` repeats whatever `og:image:alt` is. A page setting its own `og:image` keeps neither the size nor the alt text of the site's image: it sets `meta(property="og:image:alt" content="...")` beside it.
- JSON-LD goes in a `head` block as a `script(type="application/ld+json")` holding its text, which `jsonLd()` from `kay/seo` writes from typed data in a server fence: `const place = jsonLd({ '@type': 'LocalBusiness', 'name': shop.name })`, then `script(type="application/ld+json") {place}`. It adds the schema.org `@context` unless the data names its own, and takes a list as one `@graph`; the type checks `@type` only, the rest being schema.org's vocabulary. Any `<` in a JSON script is written `\u003c`, so a value holding `</script>` cannot end it. `seo.jsonLd` takes the same data.
- `breadcrumbList(trail)` from `kay/seo` gives a page's breadcrumb trail as the `BreadcrumbList` search engines read, home first: `jsonLd(breadcrumbList([{ name: 'Home', path: '/' }, { name: 'Services', path: '/services' }]))`, each path made absolute by `siteUrl`.
- `siteUrl('/contact')` from `kay/seo` gives an absolute URL of the site, `https://example.com/contact`, from `site` and `base` in kay.config.ts, for a mail, a share link or structured data; a path ending with a slash under `trailingSlash: 'always'`, as canonical links do; it throws on the server when `site` is not set, prerendered pages included, and in the browser reads the page's own origin. `siteUrl()` is the home page's, and `siteOrigin()` the origin alone, `https://example.com`, without `base`. The site is the one the last `pages()` or build of the process read, one site per process.
- `export const noindex = true` in a page's server fence asks search engines to leave it out, `<meta name="robots" content="noindex">` in its head, a `robots` tag of its own still winning, and leaves it out of the sitemap, as legal pages often are.
- Without `site` and `seo`, a page's head holds only the tags it and its layouts set.

## Sitemap and robots.txt

A project with a `site` serves `/sitemap.xml` and `/robots.txt`, which allows every crawler and points at the sitemap; a file of the same name in `public/` replaces either. The sitemap lists:

- every page without params, unless its server fence has `export const sitemap = false` or `export const noindex = true`;
- for a page with params, the ones its `sitemap` export lists, else the ones its `prerender` export lists, else none. `sitemap` takes what `prerender` takes: `true`, `false`, a content collection, a list of params or a function returning one;
- a page behind a guard only when its `sitemap` export lists it.

```kay
--- server
import { findPost, listPosts } from '../../data'

export async function sitemap() {
  return (await listPosts()).map(post => ({ slug: post.slug }))
}

const post = await findPost(ctx.params.slug) ?? ctx.notFound()
---
h1 {post.title}
```

In production the sitemap is built on the first request and kept for an hour; development builds it per request.

## Favicon and web manifest

`favicon` in `kay.config.ts` names a square image relative to the root, 512 pixels wide or more for sharp icons (a smaller one is enlarged, with a warning naming it): `favicon: 'src/favicon.png'`. kay serves it as `/favicon.ico` (16, 32 and 48 pixels), `/apple-touch-icon.png` (180), `/icon-192.png` and `/icon-512.png`, plus `/manifest.webmanifest`, and links them from every page. `kay build` writes them; development makes them from the image on first request. Each path a public file or a page already serves is left to it. A project that names none gets kay's own mark, and `favicon: false` turns the favicon, its links and the manifest off.

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  favicon: 'src/favicon.png',
  seo: { name: 'Example' },
  manifest: { shortName: 'Ex', themeColor: '#1e1e2e', backgroundColor: '#11111b', display: 'standalone' },
})
```

The manifest is named after `seo.name`, `shortName` defaulting to it, and described by `seo.description`; `themeColor` is also every page's `theme-color`, `favicon: false` included.

## Offline

`offline: true` in `kay.config.ts` turns on a service worker, which keeps the site's files and some of its pages for a visitor who lost their connection or opens the installed site with none:

```ts
export default defineConfig({
  offline: { pages: ['/', '/menu'], fallback: '/offline' },
})
```

- Every page carries a script registering `/sw.js`, under the site's `base`, once it has loaded; the policy allows it by hash as kay's other inline scripts. Off, nothing is added to a page.
- On its install the worker fetches the build's scripts, stylesheets and fonts, every page `pages` lists, as paths of the site, every prerendered page no guard covers without it, which the server warns about past 100, since each visitor downloads them on every deploy, and the `fallback` page. The build's other files, such as images, are kept as they are first loaded. It answers the build's files from what it keeps, so islands hydrate offline.
- A page is fetched from the network first, a kept page's copy refreshed each time, unless its response says `private` or `no-store`; offline, the kept copy answers, then the `fallback` page, then a plain page kay writes saying the page needs a connection, with status 503. A page swap fetches through it too, so following a link between kept pages works offline.
- Actions, API routes and every other path under `/_kay/` always go to the network, as does any request other than GET, to another site, or for a range, as a video or an audio file asks for. Only a full 200 for the URL asked is kept, never one a redirect led to. `/_kay/env.js` is fetched from the network first and kept for offline islands.
- The worker's cache is named after the build and the prerendered pages, so a deploy changes `/sw.js`, which the browser checks as a page loads; the new worker takes over at once, drops the old cache, and the page swap goes on fetching through it. Nothing has to be cleared by hand.
- `kay dev` adds no script, and its `/sw.js` removes a worker a production run left on the same origin. Turning `offline` off does the same for visitors who had it. A public file or a page at `/sw.js` wins over kay's.

## Fonts

`fonts` in `kay.config.ts` self-hosts font files: each is served as a content-named asset, declared by `@font-face` rules in a `<style>` of every page's head, which spares the first paint a request of their own at the cost of a few hundred bytes per face in every page, and preloaded only with `preload: true`.

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  fonts: [
    { family: 'Inter', src: '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2', weight: '100 900', preload: true },
    { family: 'Lora', src: 'src/fonts/lora-italic.woff2', style: 'italic' },
  ],
})
```

- An installed Fontsource package is listed once, its family name and files read from it: `{ fontsource: '@fontsource/open-sans', weights: [400, 600, 700], styles: ['normal', 'italic'] }` declares a face per weight and style, and `{ fontsource: '@fontsource-variable/inter' }` one per style spanning every weight, with no `weights`. `subset` defaults to the package's own, `latin` for most, `styles` to `['normal']`, and `display` applies to every face; a weight, style or subset the package lacks stops the build, naming the ones it has. A face to preload is written as a file entry.
- `src` is a `.woff2`, `.woff`, `.ttf` or `.otf` file relative to the root, or a file of an installed package. `weight` defaults to 400, or takes a range for a variable font; `style` to `normal`; `display` to `swap`; `unicodeRange` is passed through.
- A stylesheet names the family as it would any other: `font-family: Inter, system-ui, sans-serif`. With Tailwind, `@theme { --font-sans: Inter, system-ui, sans-serif; }`.
- A face loads once the page uses it, its text showing in the fallback font until then (`display: swap`). `preload: true` fetches it with the page instead, so text is likelier to paint in it first, but on a slow phone a preload shares the link with the stylesheet and holds back the first paint: dropping its two preloads painted jb-peinture about 190 ms sooner on a throttled phone, with no layout shift to speak of. Preload a face only when text painting in it first matters more than painting sooner.
