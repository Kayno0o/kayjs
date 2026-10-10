# Content collections

A collection is a folder of Markdown files, or of JSON and YAML data files, read against a schema. The project declares its collections in `src/content.config.ts`, or the module `content` names in kay.config.ts, each folder relative to that module:

```ts
import { s } from 'kay'
import { collection } from 'kay/content'
import Callout from './components/callout.kay'

export const posts = collection('content/posts', {
  schema: s.Object({
    title: s.String(),
    date: s.Date(),
    tags: s.Array(s.String(), { default: [] }),
    draft: s.Optional(s.Boolean()),
  }),
  components: { Callout },
  draft: post => post.data.draft === true,
  sort: (a, b) => b.data.date.getTime() - a.data.date.getTime(),
  feed: {
    path: '/blog/rss.xml',
    title: 'Blog',
    item: post => ({
      title: post.data.title,
      path: `/blog/${post.slug}`,
      date: post.data.date,
    }),
  },
})

export const authors = collection('content/authors', {
  schema: s.Object({ name: s.String() }),
})
```

A page reads it in its server fence, typed from the schema:

```kay
--- server
import { posts } from '../../content.config'

export const prerender = posts

const post = await posts.get(ctx.params.slug) ?? ctx.notFound()
const { Content } = post
---
h1 {post.data.title}
nav
  for heading of post.headings
    a(href={`#${heading.id}`}) {heading.text}
article
  Content
```

- `all()` gives every entry in the collection's `sort` order, by slug without one; filter and sort it like any array. `get(slug)` gives one entry or `undefined`. An entry `draft` returns true for shows in `kay dev` and to a visitor in preview mode only: everywhere else it is left out of `all()`, `get()`, prerendering, the sitemap and the feed. Two files giving one slug, `guides.md` and `guides/index.md`, fail the collection.
- An entry has `slug`, its path in the folder without the extension (`guides/intro`; an `index` file takes its folder's), `data`, `headings` (`{ depth, id, text }` in order, for a table of contents), `Content`, the component rendering its body, and `file`. A data file's `headings` is empty and its `Content` renders nothing.
- A Markdown file starts with YAML frontmatter between `---` lines. Every entry's data is read against the schema: defaults filled in, an `s.Date()` decoded from its text. An entry it refuses, or one that does not parse, fails `kay check` at the field's line, and fails `kay build` and the first load.
- Headings get ids, deduplicated, and link to themselves. Bare URLs become links.
- `highlight: (code, language) => html` highlights code blocks as entries compile, at build time: it returns the whole `<pre>`, such as Shiki's `codeToHtml`, which the site depends on itself. Without one, a block renders as `<pre><code class="language-ts">`.
- A Markdown entry uses the components its collection's `components` names, written with a capital as in a template: `<Callout type="warn">` on its own line, Markdown inside after a blank line, then `</Callout>` on its own line; `<Badge text="new" />` inline. Attributes are text (`type="warn"`), JSON in braces (`count={3}`, `items={["a", "b"]}`), or bare for `true`, and may spread over several lines. An interactive component renders as an island and hydrates as in any page. A page rendering an entry's `Content` links the stylesheets those components import, for every collection its `--- server` fence imports. A tag in a code span, a fenced code block or an indented one stays text. A component the collection does not name, or a tag left open, fails `kay check` and the build.
- `export const prerender = posts` in a page with one param prerenders a page per entry, its slug as the param; `sitemap` takes a collection the same way. A slug with a slash needs a catch-all page, `[...slug].kay`.
- `paginate(posts, 10)` from `kay/content` splits a collection, an array, or a function returning one into pages, for a page whose one param is optional, `blog/[[page=integer]].kay`: `const blog = paginate(posts, 10)`, `export const prerender = blog`, then `const list = await blog.page(ctx.params.page) ?? ctx.notFound()`. `list` has `items`, `page` and `pages`, from 1, `prev` and `next`, links undefined at the ends, and `href(n)`. Page 1 is the list's own path, `/blog`, and `page()` gives `undefined` for `/blog/1`, a page past the last, or anything but a whole number from 1. Its links are in the request's locale, under `base`, with a trailing slash under `trailingSlash: 'always'`. Exported as `prerender` or `sitemap` it lists every page; a localized collection counts each locale's entries, the default locale's standing in for those it lacks, so a locale with more entries has more pages, listed in it alone. kayjs-ui's `Pagination(of={list})` draws its links.
- `renderMarkdown(text, { highlight })` from `kay/content` renders Markdown the app has at runtime, such as a user's note or a feed, as entries render, headings anchored and code highlighted when given a highlighter, and gives `{ html, headings }`. The HTML is the writer's, raw tags included, so a user's goes through `sanitizeHtml` before `innerHTML`, and a user may add headings by typing their tags. The highlighter gets a fence's language as the user typed it, so it falls back for one it does not know rather than throw. `highlightCode(code, 'ts', { highlight })` renders one code block the same way, `<pre><code class="language-ts">` without a highlighter, as a `SafeHtml`: `const snippet = await highlightCode(source, 'ts', { highlight })` in a server fence, then `div(innerHTML={snippet})`. Both run on the server.
- Entries are the site's own content, trusted: their HTML, links and what a highlighter returns go out as written, unsanitised.
- `feed` serves an RSS 2.0 feed at its path, `format: 'atom'` for Atom, its `author` the feed's title unless set: the newest `limit` items, 20 by default, that `item` returns, links absolute on the `site` kay.config.ts sets, which a feed needs. A link to its path, such as `link(rel="alternate" href="/blog/rss.xml")` in a layout, passes `kay check` when the path is written as a literal.
- `localized: true` keeps each entry in a folder named after its locale, `fr/hello.md` and `en/hello.md` being translations of one entry, slug `hello`, with `i18n` in kay.config.ts (see locales). `all()` and `get(slug)` read the request's locale, the default locale's entry standing in for one the locale lacks or keeps as a draft; `entry.locale` names the folder it came from and `entry.translations` the locales holding the slug. Either takes a locale as last argument; outside a request `all()` gives every locale's entries and `get(slug, locale)` reads that locale's alone, with no fallback. A page prerendering or listing the collection in its sitemap gets each slug once, in every locale. The feed is served once per locale, `/en/blog/rss.xml`, listing only the entries written in it, its links in that locale; with domains each host serves its own at the path. An entry outside a locale folder fails `kay check` and the build.
- `posts.invalidate()` loads the entries afresh on the next read; for a folder that only matters in development, where the files change.
- Each entry compiles once and is cached in `.kay/cache/content` by its content, the highlighter's source and Bun's version, so a change, which restarts `kay dev`, recompiles that entry only. A highlighter whose output changes with no change to its source, such as a new theme passed in, needs that folder cleared. `kay build` compiles every collection into `.kay/client/content`, which production reads, an executable included, instead of the files.

## Loaded collections

A collection whose entries live in a headless CMS, an API or a database takes a loader instead of a folder, and is read, typed and used as a folder's is:

```ts
import { s } from 'kay'
import { collection } from 'kay/content'
import { listPosts } from './cms'

export const news = collection({
  name: 'news',
  load: async ({ preview }) => (await listPosts({ drafts: preview }))
    .map(post => ({
      slug: post.slug,
      data: { title: post.title, published: post.status === 'published' },
      html: post.content,
    })),
  ttl: '15m',
}, {
  schema: s.Object({ title: s.String(), published: s.Boolean() }),
  draft: post => !post.data.published,
})
```

- `load` gives an array of `{ slug, data, body }` or `{ slug, data, html }`: `data` is read against the schema, defaults filled in and dates decoded; `body` is Markdown, compiled as a file's body, headings listed, code highlighted and the collection's components usable; `html` is rendered as it is, trusted as a file entry's is. An entry's `file` is the collection's name and its slug, `news/launch`. An entry the schema refuses, one with no slug or with another entry's, or a load giving anything but an array, fails the read with every problem named, and the next read loads again.
- `load` gets `preview: true` for a visitor in preview mode and in `kay dev`, for a CMS that serves drafts apart.
- The entries are loaded on the first read and kept as `cached` keeps a value (see [Caching](rendering.md#caching)): concurrent first reads share one load; with `ttl`, a read past it gets them as they were and refreshes them in the background; without, they are kept until `invalidate()` or a restart. `store: sqliteCache(path)` keeps them across restarts and has `invalidate()` reach every process sharing it.
- `prerender`, `sitemap` and a feed take a loaded collection as a folder's: `kay build` loads it to prerender, so it needs the CMS to answer. `kay check` types it from the schema but never calls the loader, and `kay build` writes nothing of it for production, which reads it when the server runs.
- A CMS's webhook refreshes it through an API route, and refreshes the prerendered pages showing it:

```ts
// src/api/cms.ts
import { api, invalidatePage } from 'kay/server'
import { news } from '../content.config'

export default api().post('/', ({ headers, status }) => {
  if (headers['x-webhook-secret'] !== process.env.CMS_WEBHOOK_SECRET)
    return status(401)

  news.invalidate()
  invalidatePage(path => path.startsWith('/news'))

  return new Response(null, { status: 204 })
})
```

## Preview mode

`preview` in kay.config.ts lets an editor see drafts on the live site:

```ts
export default defineConfig({
  preview: { secret: process.env.PREVIEW_SECRET! },
})
```

- A visitor in preview mode sees what `kay dev` shows: every draft of every collection, a loaded collection loaded afresh once per request with `preview: true`, a prerendered page rendered afresh rather than served from its copy, and `cached()` calling its load each time and keeping nothing. Their pages go out with `Cache-Control: private, no-store` and no ETag, so no cache keeps them, and no other visitor ever gets one. A CDN in front caching pages needs to pass requests carrying the `kay_preview` cookie through.
- A CMS's preview link opens `/_kay/preview?secret=<secret>&path=/news/draft`, under the site's `base`: it sets the `kay_preview` cookie, HTTP-only, for `preview.maxAge`, an hour by default, and goes to the path, written without the base. A wrong secret answers 403, and a path that is no path of the site 400.
- `previewUrl('/news/draft')` from `kay/server` gives a link doing the same without the secret, signed with it and valid an hour, `previewUrl(path, { ttl: '1d' })` longer: one to hand an editor. Prefer it where the CMS can call the site, since a link carrying the secret stays in the editor's history and any proxy log, and whoever reads it can sign their own.
- `enterPreview(ctx)` from `kay/server` sets the cookie from a guard, a page or an action whose `ctx` carries cookies, such as a guard letting a signed-in editor in; `exitPreview(ctx)` clears it, as `/_kay/preview?exit&path=/` does for anyone.
- `previewing()` from `kay` is true while the server renders for a visitor in preview mode, for a layout to show a banner with a link out: `if previewing()` then `a(href="/_kay/preview?exit&path=/") Leave preview`. In the browser it is false.
- `preview.secret` is at least 32 random characters, read from the environment: it signs the cookie and the links, and is what a CMS's link carries, so changing it ends every preview. A server without `preview` ignores the cookie, and `previewUrl` and `enterPreview` throw there.
