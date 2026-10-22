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

In a layout's `page` it covers every page under it, the sitemap and the search index too; a page's own `noindex: false` takes it back.

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
- `lang` is kay's from `lang` in kay.config.ts or the locale, and `html(lang="fr")` in a page or layout sets that page's own on a site without `i18n`, `dir` following it; with `i18n` the locale decides and the tag is ignored. `dir` is kay's alone. A link to a page of another `lang` loads it in full, and messages and dates keep the site's language.
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

- With `i18n`, `name`, `titleTemplate`, `description`, `image`, `imageAlt` and `locale` each take a string or a record of one string per locale, `description: { en: 'What the site is', fr: 'Ce qu\'est le site' }`, so no page sets a tag for its language's; a locale the record lacks reads the default locale's. The head lints check every text. Each surface reads the locale it is served for: the page's tags and share card name follow the page's locale, and the web manifest does too (see below), but the one OpenAPI document is titled with the default locale's `name`.
- `head` adds tags to every page's head, written as a `head` block compiles them, a tag's text as `children`: `head: [{ tag: 'script', props: { src: '/stats.js', defer: true } }, { tag: 'meta', props: { name: 'color-scheme', content: 'light dark' } }]`. An analytics script that needs the visitor's consent loads from an island once they agreed (see [Privacy](privacy.md)).
- A layout or the page setting a tag of the same identity replaces one of those.
- An inline script or style among them is let through by the content security policy, its hash added.
- `site` is an origin, nothing after the host.
- Left out of kay.config.ts, `site` is read from `SITE_URL`, a server and `kay build` alike, so one build serves each host it is deployed to: production, a preview, the e2e server. A literal `site` in kay.config.ts wins over `SITE_URL`; the deprecated `ORIGIN`, a plain http(s) origin, is read when `SITE_URL` is unset, with a warning, until 1.73. Server code reads it as `siteUrl()` and `siteOrigin()` from `kay/seo`, which kayjs-auth and kayjs-mail build their links on, so the origin is set once. Under `kay dev` with no `SITE_URL` or `ORIGIN`, the site is `http://localhost:<port>`, the port asked for, so OAuth callbacks and mailed links work in development with no setup.
- `kay build` does not report `missing-site` for such a server build; the server warns once at boot when `seo` is set and `SITE_URL` is not set either.
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
- `og:type` is `website`, `article` on a page showing one dated content entry (see below).
- A page that `prerender`s or lists in the `sitemap` a collection by one param takes that entry's `title`, `description` and date for its head: `title`, `meta description`, and, from `publishAt`'s field or else `date`, `publishedAt` or `published`, `og:type` `article` and `article:published_time`. The page's own `head` tags and a missing field leave the layout's.
- `seo.themeColor` sets every page's `theme-color`: `'#1e1e2e'` for one, `{ light: '#ffffff', dark: '#111111' }` for one meta per colour scheme (`media="(prefers-color-scheme: light)"`, then dark). It defaults to `manifest.themeColor`, which the manifest keeps for the installed app; a page's own `theme-color` meta replaces the site's of the same `media`.
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
- `kay build` reads the prerendered pages against one another and warns of shared titles and descriptions, a title over 60 characters, an orphan page, a canonical link or redirect leading to a redirect or a missing page and alternates that do not point back: the `seo` lints in [Lints](lints.md#seo-lints).
