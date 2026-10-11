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

export const page = { prerender: posts }

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

- `all()` gives every entry in the collection's `sort` order, by slug without one; filter and sort it like any array. `get(slug)` gives one entry or `undefined`. An entry `draft` returns true for shows in development (`kay dev`, or the server's `dev` option, which wins over `NODE_ENV`) and to a visitor in preview mode only: everywhere else it is left out of `all()`, `get()`, prerendering, the sitemap and the feed. Two files giving one slug, `guides.md` and `guides/index.md`, fail the collection. `draft: 'draft'`, a boolean field's name, holds back the entries where it is true, which a CMS then reads and publishes by writing false.
- An entry has `slug`, its path in the folder without the extension (`guides/intro`; an `index` file takes its folder's), `data`, `headings` (`{ depth, id, text }` in order, for a table of contents), `Content`, the component rendering its body, and `file`. A data file's `headings` is empty and its `Content` renders nothing.
- A Markdown file starts with YAML frontmatter between `---` lines. Every entry's data is read against the schema: defaults filled in, an `s.Date()` decoded from its text. An entry it refuses, or one that does not parse, fails `kay check` at the field's line, and fails `kay build` and the first load.
- Headings get ids, deduplicated, and link to themselves. Bare URLs become links.
- `highlight: (code, language) => html` highlights code blocks as entries compile, at build time: it returns the whole `<pre>`, such as Shiki's `codeToHtml`, which the site depends on itself. Without one, a block renders as `<pre><code class="language-ts">`.
- A Markdown entry uses the components its collection's `components` names, written with a capital as in a template: `<Callout type="warn">` on its own line, Markdown inside after a blank line, then `</Callout>` on its own line; `<Badge text="new" />` inline. Attributes are text (`type="warn"`), JSON in braces (`count={3}`, `items={["a", "b"]}`), or bare for `true`, and may spread over several lines. An interactive component renders as an island and hydrates as in any page. A page rendering an entry's `Content` links the stylesheets those components import, for every collection its `--- server` fence imports. A tag in a code span, a fenced code block or an indented one stays text. A component the collection does not name, or a tag left open, fails `kay check` and the build.
- `export const page = { prerender: posts }` in a page with one param prerenders a page per entry, its slug as the param; `sitemap` takes a collection the same way. A slug with a slash needs a catch-all page, `[...slug].kay`.
- `paginate(posts, 10)` from `kay/content` splits a collection, an array, or a function returning one into pages, for a page whose one param is optional, `blog/[[page=integer]].kay`: `const blog = paginate(posts, 10)`, `export const page = { prerender: blog }`, then `const list = await blog.page(ctx.params.page) ?? ctx.notFound()`. `list` has `items`, `page` and `pages`, from 1, `prev` and `next`, links undefined at the ends, and `href(n)`. Page 1 is the list's own path, `/blog`, and `page()` gives `undefined` for `/blog/1`, a page past the last, or anything but a whole number from 1. Its links are in the request's locale, under `base`, with a trailing slash under `trailingSlash: 'always'`. As the `prerender` or `sitemap` key of `page` it lists every page; a localized collection counts each locale's entries, the default locale's standing in for those it lacks, so a locale with more entries has more pages, listed in it alone. kayjs-ui's `Pagination(of={list})` draws its links.
- `renderMarkdown(text, { highlight })` from `kay/content` renders Markdown the app has at runtime, such as a user's note or a feed, as entries render, headings anchored and code highlighted when given a highlighter, and gives `{ html, headings }`. The HTML is the writer's, raw tags included, so a user's goes through `sanitizeHtml` before `innerHTML`, and a user may add headings by typing their tags. The highlighter gets a fence's language as the user typed it, so it falls back for one it does not know rather than throw. `highlightCode(code, 'ts', { highlight })` from `kay/content` renders one code block the same way, `<pre><code class="language-ts">` without a highlighter, as a `SafeHtml`: `const snippet = await highlightCode(source, 'ts', { highlight })` in a server fence, then `div(innerHTML={snippet})`. Both run on the server.
- `markdownHtml(text)` from `kay/markdown` renders Markdown a user writes as it comes, in an island too, such as a chat reply streaming in or an editor's preview: `div(innerHTML={markdownHtml(text())})`. It is `renderMarkdown`'s HTML put through `sanitizeHtml`, keeping tables, their `align`, images (`src`, `alt`, `title`) and the disabled checkboxes of task lists as well, with plain headings, no id or anchor, and no code classes, so it is a `SafeHtml`; it is sync and fast enough to run again on every chunk. On the server it is Bun.markdown; in an island marked, with a renderer writing the same HTML, which only the islands importing it load, about 15 KB gzipped, plus `sanitizeHtml` in the runtime every page with an island loads, 1.3 KB, unless something already uses it. The two differ only where Bun.markdown is odd: a named reference such as `&copy;` stays written in the island, which the browser shows the same; a URL with parentheses or a `"` in its path, and one still being typed, without a dot yet or ending in `=`, is a link in the island alone; a task item whose text the next line underlines as a heading is not a task in the island. The island keeps marked linear: an emphasis or a strikethrough closes within 1,000 characters there, and text past 100,000 characters, or nested too deep for marked, shows as it is written.
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
- `load` gets `preview: true` for a visitor in preview mode and in development (`kay dev`, or the server's `dev` option), for a CMS that serves drafts apart.
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
- `enterPreview(ctx)` from `kay/server` sets the cookie from a guard, a page or an action whose `ctx` carries cookies, such as a guard letting a signed-in editor in; `exitPreview(ctx)` from `kay/server` clears it, as `/_kay/preview?exit&path=/` does for anyone.
- `previewing()` from `kay` is true while the server renders for a visitor in preview mode, for a layout to show a banner with a link out: `if previewing()` then `a(href="/_kay/preview?exit&path=/") Leave preview`. In the browser it is false.
- Edit mode is preview mode for a CMS editing content on the page: `enterPreview(ctx, { edit: true })` from the CMS's guarded route, `previewUrl(path, { edit: true })`, or `/_kay/preview?edit&path=...&secret=...` enter it, signed apart so no preview link or cookie becomes one, and `exitPreview` leaves both. Everything preview mode does holds, and `editing()` from `kay` is true while the server renders for such a visitor; `editRequested(request)` from `kay/server` tells the same of any request, for the CMS's own API modules and guards.
- In edit mode the page marks what each entry's fields render, with nothing to declare: an element a field's text or number fills whole takes `data-kay-field="<collection>:<slug>[@locale]:<path>"`, the collection named as the content config exports it and the path dotted with indexes (`tags.0`); an attribute a field gives takes `data-kay-field-<name>`; text mixed with other text sits between `<!--kay-field ...-->` and `<!--/kay-field-->`; the element a `for` over a field's array fills takes `data-kay-list`; the element `Content` fills takes `data-kay-body="<collection>:<slug>[@locale]"`, else `<!--kay-body ...-->` comments. Islands, the static slots passed to them and the deferred parts of a streamed page stay unmarked, and outside edit mode the markup is unchanged.
- A field is told apart by its value: a text is marked when it equals one a field gave and that is not rendered yet, the first read when several fields give the same text; a number only when rendered right after its field is read, nothing else read or rendered between. A transformed value (`toUpperCase()`, a formatted date, a joined list) goes unmarked and a blank text is never marked. A text read but never rendered, such as `status` in `if status === 'draft'`, marks the next equal text rendered, a literal `"draft"` or another field holding it, as that field; a number computed right after its field's read, equal to it, is marked as it. A collection the content config does not export is named by its folder or loader name.
- `showDraft(entries)` from `kay/edit`, called from the editor's island, shows the page with entries the editor has not saved in place of theirs, through the page swap, keeping scroll, focus and every island whose props did not change. Each entry is `{ collection, slug, locale?, data, body? }`, `collection` the config's export name and `body` Markdown. It resolves `{}` once shown, or `{ issues: [{ collection, slug, locale?, path, message }] }` showing nothing when the data fails the schema, `path` dotted (`tags.0`), `'body'` for a body using a component the collection does not name, `''` for a `locale` missing from an entry of a localized collection or given to another. A newer call cancels an older one, and going to another page cancels it too; either resolves `{}`. It throws outside edit mode (403), on a body over `bodyLimit` (413) and when the page fails to render (500).
- `preview.secret` is at least 32 random characters, read from the environment: it signs the cookie and the links, and is what a CMS's link carries, so changing it ends every preview. A server without `preview` ignores the cookie, and `previewUrl` and `enterPreview` throw there.

## A CMS editing the collections

A CMS running in the app's server, as a kay extension, reads and edits the collections the content config exports, through `kay/content`:

- `await collections()` from `kay/content` describes each: `{ name, kind: 'folder' | 'loaded', schema, body?, localized, dir?, draftField?, repoRoot }`. `name` is the export name, the one the page's markers and `showDraft` use; `schema` is plain JSON Schema, a date a `date-time` string; `body: { kind: 'markdown' }` when entries hold a Markdown body; `dir`, a folder collection's, is relative to `repoRoot`, the repository holding the project.
- `reference`, `imageField`, `fileField` and `markdownField` from `kay/content` give string fields a CMS edits apart, `reference('authors')` say, reported in the schema as `x-kay: { kind, collection? }`: the slug of another collection's entry, an image's or a file's path, Markdown.
- `await entries(name, { locale? })` from `kay/content` lists the entries as their source holds them, drafts included: `{ slug, locale?, path?, data, body?, draft }`, a folder entry's file as written with its `path` relative to `repoRoot`, a loaded entry as `load({ preview: true })` gives it; `draft` says whether the collection's `draft` holds it back.
