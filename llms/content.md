# Content collections

## Common tasks

### Declare a collection

A collection is a folder of Markdown files, read against a schema, declared in `src/content.config.ts`:

```ts
import { s } from 'kay'
import { collection } from 'kay/content'

export const posts = collection('content/posts', {
  schema: s.Object({
    title: s.String(),
    date: s.Date(),
    tags: s.Array(s.String(), { default: [] }),
    draft: s.Optional(s.Boolean()),
  }),
  draft: post => post.data.draft === true,
  sort: (a, b) => b.data.date.getTime() - a.data.date.getTime(),
})
```

### List the entries on a page

`all()` gives every entry in the collection's `sort` order, read in a page's server fence and typed from the schema:

```kay
--- server
import { posts } from '../content.config'

const recent = (await posts.all()).slice(0, 5)
---
ul
  for post of recent
    li
      a(href={`/blog/${post.slug}`}) {post.data.title}
```

### Show one entry per page

`get(slug)` gives one entry, `Content` renders its body and `headings` list its titles, and `prerender: posts` builds a page per entry, `src/blog/[slug].kay`:

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

### Split a list into pages

`paginate(posts, 10)` from `kay/content` splits a collection for a page whose one param is optional, `src/blog/[[page=integer]].kay`:

```kay
--- server
import { paginate } from 'kay/content'
import { posts } from '../../content.config'

const blog = paginate(posts, 10)

export const page = { prerender: blog }

const list = await blog.page(ctx.params.page) ?? ctx.notFound()
---
for post of list.items
  a(href={`/blog/${post.slug}`}) {post.data.title}
if list.prev
  a(href={list.prev}) Newer
if list.next
  a(href={list.next}) Older
```

### Use a component in a Markdown entry

The collection's `components` names the components a Markdown file may write with a capital, `<Callout type="warn">`:

```ts
import { s } from 'kay'
import { collection } from 'kay/content'
import Callout from './components/callout.kay'

export const posts = collection('content/posts', {
  schema: s.Object({ title: s.String() }),
  components: { Callout },
})
```

### Serve an RSS feed

`feed` serves an RSS 2.0 feed at its `path`, built from what `item` returns for each entry:

```ts
import { s } from 'kay'
import { collection } from 'kay/content'

export const posts = collection('content/posts', {
  schema: s.Object({ title: s.String(), date: s.Date() }),
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
```

### Keep one entry per locale

`localized: true` keeps each entry in a folder named after its locale, `content/posts/fr/hello.md` and `content/posts/en/hello.md` being translations of one entry:

```ts
import { s } from 'kay'
import { collection } from 'kay/content'

export const posts = collection('content/posts', {
  schema: s.Object({ title: s.String() }),
  localized: true,
})
```

### Load entries from a headless CMS

A collection takes a `load` function in place of a folder, and a webhook refreshes it through an API route, `src/api/cms.ts`:

```ts
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

### Let an editor see drafts on the live site

`preview` in kay.config.ts takes a secret, and `previewUrl` from `kay/server` gives a signed link to a page, valid an hour:

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  preview: { secret: process.env.PREVIEW_SECRET! },
})
```

### Render Markdown a user writes

`markdownHtml(text)` from `kay/markdown` renders it as it comes, in an island too, as a `SafeHtml`:

```kay
---
import { markdownHtml } from 'kay/markdown'

const text = signal('')
---
textarea(bind:value={text} aria-label="Message")
div(innerHTML={markdownHtml(text())})
```

## Reference

### Collections

A collection is a folder of Markdown files, or of JSON and YAML data files, read against a schema.

The project declares its collections in `src/content.config.ts`, or the module `content` names in kay.config.ts, each folder relative to that module:

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

#### Reading entries

- `all()` gives every entry in the collection's `sort` order, by slug without one; filter and sort it like any array.
- `get(slug)` gives one entry or `undefined`.
- An entry has `slug`, its path in the folder without the extension (`guides/intro`; an `index` file takes its folder's), `data`, `headings` (`{ depth, id, text }` in order, for a table of contents), `Content`, the component rendering its body, and `file`.
- A data file's `headings` is empty and its `Content` renders nothing.
- Two files giving one slug, `guides.md` and `guides/index.md`, fail the collection.
- Entries are the site's own content, trusted: their HTML, links and what a highlighter returns go out as written, unsanitised.

#### Drafts

- An entry `draft` returns true for shows in development (`kay dev`, or the server's `dev` option, which wins over `NODE_ENV`) and to a visitor in preview mode only.
- Everywhere else a draft is left out of `all()`, `get()`, prerendering, the sitemap and the feed.
- `draft: 'draft'`, a boolean field's name, holds back the entries where it is true, which a CMS then reads and publishes by writing false.

#### Markdown files

- A Markdown file starts with YAML frontmatter between `---` lines.
- Every entry's data is read against the schema: defaults filled in, an `s.Date()` decoded from its text.
- An entry it refuses, or one that does not parse, fails `kay check` at the field's line, and fails `kay build` and the first load.
- Headings get ids, deduplicated, and link to themselves.
- Bare URLs become links.
- `highlight: (code, language) => html` highlights code blocks as entries compile, at build time: it returns the whole `<pre>`, such as Shiki's `codeToHtml`, which the site depends on itself.
- Without a highlighter, a block renders as `<pre><code class="language-ts">`.

#### Components in Markdown

- A Markdown entry uses the components its collection's `components` names, written with a capital as in a template: `<Callout type="warn">` on its own line, Markdown inside after a blank line, then `</Callout>` on its own line; `<Badge text="new" />` inline.
- Attributes are text (`type="warn"`), JSON in braces (`count={3}`, `items={["a", "b"]}`), or bare for `true`, and may spread over several lines.
- Their text never becomes markup: an `innerHTML` attribute, or JSON holding an object with a string `t` (how kay marks markup), fails the build.
- An interactive component renders as an island and hydrates as in any page.
- A page rendering an entry's `Content` links the stylesheets those components import, for every collection its `--- server` fence imports.
- A tag in a code span, a fenced code block or an indented one stays text.
- A component the collection does not name, or a tag left open, fails `kay check` and the build.

#### Pages from a collection

- `export const page = { prerender: posts }` in a page with one param prerenders a page per entry, its slug as the param; `sitemap` takes a collection the same way.
- A slug with a slash needs a catch-all page, `[...slug].kay`.

#### Pagination

- `paginate(posts, 10)` from `kay/content` splits a collection, an array, or a function returning one into pages, for a page whose one param is optional, `blog/[[page=integer]].kay`: `const blog = paginate(posts, 10)`, `export const page = { prerender: blog }`, then `const list = await blog.page(ctx.params.page) ?? ctx.notFound()`.
- `list` has `items`, `page` and `pages`, from 1, `prev` and `next`, links undefined at the ends, and `href(n)`.
- Page 1 is the list's own path, `/blog`, and `page()` gives `undefined` for `/blog/1`, a page past the last, or anything but a whole number from 1.
- Its links are in the request's locale, under `base`, with a trailing slash under `trailingSlash: 'always'`.
- As the `prerender` or `sitemap` key of `page` it lists every page; a localized collection counts each locale's entries, the default locale's standing in for those it lacks, so a locale with more entries has more pages, listed in it alone.
- kayjs-ui's `Pagination(of={list})` draws its links.

#### Rendering Markdown

- `renderMarkdown(text, { highlight })` from `kay/content` renders Markdown the app has at runtime, such as a user's note or a feed, as entries render, headings anchored and code highlighted when given a highlighter, and gives `{ html, headings }`.
- The HTML is the writer's, raw tags included, so a user's goes through `sanitizeHtml` before `innerHTML`, and a user may add headings by typing their tags.
- The highlighter gets a fence's language as the user typed it, so it falls back for one it does not know rather than throw.
- `bodyHtml(body)` from `kay/content` gives the HTML an entry's body puts on the page, each component standing as a `<kay-component>` element around what it wraps, for a CMS to check what an editor wrote before saving it, and throws `MarkdownError` from `kay/content` (its `line` set) for components kay cannot read.
- `highlightCode(code, 'ts', { highlight })` from `kay/content` renders one code block the same way, `<pre><code class="language-ts">` without a highlighter, as a `SafeHtml`: `const snippet = await highlightCode(source, 'ts', { highlight })` in a server fence, then `div(innerHTML={snippet})`.
- Both run on the server.
- `markdownHtml(text)` from `kay/markdown` renders Markdown a user writes as it comes, in an island too, such as a chat reply streaming in or an editor's preview: `div(innerHTML={markdownHtml(text())})`.
- It is `renderMarkdown`'s HTML put through `sanitizeHtml`, keeping tables, their `align`, images (`src`, `alt`, `title`) and the disabled checkboxes of task lists as well, with plain headings, no id or anchor, and no code classes, so it is a `SafeHtml`; it is sync and fast enough to run again on every chunk.
- On the server it is Bun.markdown; in an island marked, with a renderer writing the same HTML, which only the islands importing it load, about 15 KB gzipped, plus `sanitizeHtml` in the runtime every page with an island loads, 1.3 KB, unless something already uses it.
- The two differ only where Bun.markdown is odd: a named reference such as `&copy;` stays written in the island, which the browser shows the same; a URL with parentheses or a `"` in its path, and one still being typed, without a dot yet or ending in `=`, is a link in the island alone; a task item whose text the next line underlines as a heading is not a task in the island.
- The island keeps marked linear: an emphasis or a strikethrough closes within 1,000 characters there, and text past 100,000 characters, or nested too deep for marked, shows as it is written.

#### Feeds

- `feed` serves an RSS 2.0 feed at its path, `format: 'atom'` for Atom, its `author` the feed's title unless set: the newest `limit` items, 20 by default, that `item` returns, links absolute on the `site` kay.config.ts sets, which a feed needs.
- A link to its path, such as `link(rel="alternate" href="/blog/rss.xml")` in a layout, passes `kay check` when the path is written as a literal.

#### Localized collections

- `localized: true` keeps each entry in a folder named after its locale, `fr/hello.md` and `en/hello.md` being translations of one entry, slug `hello`, with `i18n` in kay.config.ts (see locales).
- `all()` and `get(slug)` read the request's locale, the default locale's entry standing in for one the locale lacks or keeps as a draft; `entry.locale` names the folder it came from and `entry.translations` the locales holding the slug.
- Either takes a locale as last argument; outside a request `all()` gives every locale's entries and `get(slug, locale)` reads that locale's alone, with no fallback.
- A page prerendering or listing the collection in its sitemap gets each slug once, in every locale.
- The feed is served once per locale, `/en/blog/rss.xml`, listing only the entries written in it, its links in that locale; with domains each host serves its own at the path.
- An entry outside a locale folder fails `kay check` and the build.

#### Caching

- `posts.invalidate()` loads the entries afresh on the next read; for a folder that only matters in development, where the files change.
- Each entry compiles once and is cached in `.kay/cache/content`, one file per entry holding the content's hash, the highlighter's source and Bun's version it was compiled with, so a change, which restarts `kay dev`, recompiles that entry only.
- A highlighter whose output changes with no change to its source, such as a new theme passed in, needs that folder cleared.
- `kay build` compiles every collection into `.kay/client/content`, which production reads, an executable included, instead of the files.

### Loaded collections

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

- `load` gives an array of `{ slug, data, body }` or `{ slug, data, html }`: `data` is read against the schema, defaults filled in and dates decoded; `body` is Markdown, compiled as a file's body, headings listed, code highlighted and the collection's components usable; `html` is rendered as it is, trusted as a file entry's is.
- An entry's `file` is the collection's name and its slug, `news/launch`.
- An entry the schema refuses, one with no slug or with another entry's, or a load giving anything but an array, fails the read with every problem named, and the next read loads again.
- `load` gets `preview: true` for a visitor in preview mode and in development (`kay dev`, or the server's `dev` option), for a CMS that serves drafts apart.
- `save(entry)` and `remove(entry)` beside `load` write an entry back to the CMS, `{ slug, locale?, data, body?, create? }` and `{ slug, locale? }`, which `saveEntry` and `removeEntry` from `kay/content` call (see [A CMS editing the collections](#a-cms-editing-the-collections)).
- `create: true` comes with an entry the CMS creates: `save` throws when the entry exists, as a `save` that ignores it overwrites an entry another process created since, unnoticed.
- `save` and `remove` never call `saveEntry` or `removeEntry` for their own collection: that call waits for them to finish, so it deadlocks.
- The entries are loaded on the first read and kept as `cached` keeps a value (see [Caching](rendering.md#caching)): concurrent first reads share one load; with `ttl`, a read past it gets them as they were and refreshes them in the background; without, they are kept until `invalidate()` or a restart.
- `store: sqliteCache(path)` keeps them across restarts and has `invalidate()` reach every process sharing it.
- `prerender`, `sitemap` and a feed take a loaded collection as a folder's: `kay build` loads it to prerender, so it needs the CMS to answer.
- `kay check` types it from the schema but never calls the loader, and `kay build` writes nothing of it for production, which reads it when the server runs.
- A CMS's webhook refreshes it through an API route, and refreshes the prerendered pages showing it; the route refuses a request while the secret is unset, and compares it in constant time:

```ts
// src/api/cms.ts
import { createHash, timingSafeEqual } from 'node:crypto'
import { api, invalidatePage } from 'kay/server'
import { news } from '../content.config'

const digest = (text: string) => createHash('sha256').update(text).digest()

export default api().post('/', ({ headers, status }) => {
  const secret = process.env.CMS_WEBHOOK_SECRET
  const sent = headers['x-webhook-secret']
  if (!secret || !sent || !timingSafeEqual(digest(sent), digest(secret)))
    return status(401)

  news.invalidate()
  invalidatePage(path => path.startsWith('/news'))

  return new Response(null, { status: 204 })
})
```

### Preview mode

`preview` in kay.config.ts lets an editor see drafts on the live site:

```ts
export default defineConfig({
  preview: { secret: process.env.PREVIEW_SECRET! },
})
```

- A visitor in preview mode sees what `kay dev` shows: every draft of every collection, a loaded collection loaded afresh once per request with `preview: true`, a prerendered page rendered afresh rather than served from its copy, and `cached()` calling its load each time and keeping nothing.
- Their pages go out with `Cache-Control: private, no-store` and no ETag, so no cache keeps them, and no other visitor ever gets one.
- A CDN in front caching pages needs to pass requests carrying the `kay_preview` cookie through.
- A link expired or signed for another path answers 403, and a path that is no path of the site 400.
- `previewUrl('/news/draft')` from `kay/server` gives a preview link, `/_kay/preview?path=/news/draft&until=...&sig=...` under the site's `base`, signed with the secret and valid an hour, `previewUrl(path, { ttl: '1d' })` longer: one to hand an editor.
- The link sets the `kay_preview` cookie, HTTP-only, for `preview.maxAge`, an hour by default, and goes to the path, written without the base.
- The secret itself never travels in a URL, which stays in histories and proxy logs: a link carrying `secret=` answers 403.
- A CMS that cannot call the site links to a guarded page of the app calling `enterPreview(ctx)` instead.
- `enterPreview(ctx)` from `kay/server` sets the cookie from a guard, a page or an action whose `ctx` carries cookies, such as a guard letting a signed-in editor in; `exitPreview(ctx)` from `kay/server` clears it, as `/_kay/preview?exit&path=/` does for anyone.
- `previewing()` from `kay` is true while the server renders for a visitor in preview mode, for a layout to show a banner with a link out: `if previewing()` then `a(href="/_kay/preview?exit&path=/") Leave preview`.
- In the browser `previewing()` is false.
- `preview.secret` is at least 32 random characters, read from the environment: it signs the cookie and the links, so changing it ends every preview.
- A server without `preview` ignores the cookie, and `previewUrl` and `enterPreview` throw there.

#### Edit mode

- Edit mode is preview mode for a CMS editing content on the page: `enterPreview(ctx, { edit: true })` from the CMS's guarded route or `previewUrl(path, { edit: true })` enter it, signed apart so no preview link or cookie becomes one, and `exitPreview` leaves both.
- Everything preview mode does holds, and `editing()` from `kay` is true while the server renders for such a visitor; `editRequested(request)` from `kay/server` tells the same of any request, for the CMS's own API modules and guards.
- In edit mode the page marks what each entry's fields render, with nothing to declare: an element a field's text or number fills whole takes `data-kay-field="<collection>:<slug>[@locale]:<path>"`, the collection named as the content config exports it and the path dotted with indexes (`tags.0`); an attribute a field gives takes `data-kay-field-<name>`; text mixed with other text sits between `<!--kay-field ...-->` and `<!--/kay-field-->`; the element a `for` over a field's array fills takes `data-kay-list`; the element `Content` fills takes `data-kay-body="<collection>:<slug>[@locale]"`, else `<!--kay-body ...-->` comments.
- Islands, the static slots passed to them and the deferred parts of a streamed page stay unmarked, and outside edit mode the markup is unchanged.
- A field is told apart by its value: a text is marked when it equals one a field gave and that is not rendered yet, the first read when several fields give the same text; a number only when rendered right after its field is read, nothing else read or rendered between.
- A transformed value (`toUpperCase()`, a formatted date, a joined list) goes unmarked and a blank text is never marked.
- A text read but never rendered, such as `status` in `if status === 'draft'`, marks the next equal text rendered, a literal `"draft"` or another field holding it, as that field; a number computed right after its field's read, equal to it, is marked as it.
- A collection the content config does not export is named by its folder or loader name.

#### The editor

- A CMS's extension gives its editor as `editor: `${import.meta.dir}/editor.kay``, absolute or relative to the project root: an island every page renders at the end of its body in edit mode alone, kept alive across navigations and drafts (`persist`), and given `{ entries }`, typed `EditorProps` from `kay/edit`: each entry the page read, `{ collection, slug, locale? }`, its head and attributes included, those of the next page once the swap shows it.
- An entry read only in a deferred part of a streamed page is missing.
- The pages that extension's own `routes` serve render no editor: its screens and the `_error` or `_404` page one fails with or a guard refuses with, its own or the app's.
- An app page replacing one of its screens renders it, as another extension's pages do; a URL no page serves, `/nope` or `/admin/nope` under its prefix alike, renders none, as kay answers it outside preview mode, its `_404` showing no draft either.
- The editor needs a script the browser runs, and one extension at most gives one.
- The app's `kay check` reports the editor's errors, and those of what it imports, as its own when the extension is linked rather than installed, as a library's fixture app lists it.
- `showDraft(entries)` from `kay/edit`, called from the editor's island, shows the page with entries the editor has not saved in place of theirs, through the page swap, keeping scroll, focus and every island whose props did not change.
- Each entry is `{ collection, slug, locale?, data, body? }`, `collection` the config's export name and `body` Markdown.
- It resolves `{}` once shown, or `{ issues: [{ collection, slug, locale?, path, message }] }` showing nothing when the data fails the schema, `path` dotted (`tags.0`), `''` with `body: true` for a body that does not compile or uses a component the collection does not name, `''` with `key: 'locale'` for a locale missing from an entry of a localized collection, given to another's or not served by the site, `key: 'slug'` for a slug naming another folder, and a plain `''` for the data as a whole.
- A newer call cancels an older one, and going to another page cancels it too; either resolves `{}`.
- It throws outside edit mode (403), on a body over `bodyLimit` (413) and when the page fails to render (500).

### A CMS editing the collections

A CMS running in the app's server, as a kay extension, reads and edits the collections the content config exports, through `kay/content`. These give drafts and files to whoever calls them, so the CMS serves them from routes only an editor reaches, behind a guard or `editRequested(request)`:

- `await collections()` from `kay/content` describes each, and `await collectionInfo(name)` one alone, reading no other, undefined for a name none is exported as: `{ name, kind: 'folder' | 'loaded', schema, body?, components, localized, locales?, dir?, draftField?, count?, problem? }`, `count` the number of entries, every locale's, a folder's files listed and never read, `problem` saying why a collection's entries fail to read, a loader throwing say, `body` then assumed, the others listed still.
- `name` is the export name, the one the page's markers and `showDraft` use.
- `schema` is plain JSON Schema, a date a `date-time` string, typed `JsonSchema` from `kay/content`.
- `body: { kind: 'markdown' }` when entries hold a Markdown body (a folder holding Markdown, a loader giving `body` rather than `html`, or either with no entry yet).
- `components` names those a body may use.
- `locales`, for a localized collection, the locales the site serves.
- `dir`, a folder collection's, is relative to the repository holding the project, whose path on the server `repositoryRoot()` from `kay/content` gives, and absent for a folder outside it.
- The schemas and entries are typed as an island's props take them, so a CMS page hands its editor island `collections()` and `entries()` from `kay/content` as they come, with no cast.
- `reference`, `imageField`, `fileField` and `markdownField` from `kay/content` give string fields a CMS edits apart, `reference('authors')` say, reported in the schema as `x-kay: { kind, collection? }`: the slug of another collection's entry, the path the site serves an image or a file at (an upload's `files.url(key)` or a public file's), Markdown.
- `await entries(name, { locale?, slug?, offset?, limit? })` from `kay/content` lists the entries as their source holds them, drafts included, those of one locale, of one slug, or a stretch of them in their order (a folder's files sorted, a loader's as it gives them) when asked, a folder reading no other file, a loader giving every entry and the filter applied after (`collections()` and `collectionInfo()` from `kay/content` run a loader too, for its body and count): `{ slug, locale?, path?, data, body?, draft, problem? }`.
- `data` is an object of fields typed by `DataValue` from `kay/content` (data holding a list or a plain value comes with no `data` and its `problem`).
- A folder entry's file is as written with its `path` relative to the repository (a file that does not parse comes with no `data` and its `problem`, a Markdown one with its `body` when the frontmatter alone fails; a folder missing, as beside a build alone, throws).
- A loaded entry is as `load({ preview: true })` gives it, loaded afresh on each call as preview mode loads it.
- A locale asked of a collection that is not localized throws.
- `draft` says whether the collection's `draft` holds it back.
- `url`, under the base, is the page of the route whose `page.prerender` is the collection, in the entry's locale, a whole URL on another locale's domain, or what the collection's `url: entry => string` option gives, called with the data as the schema decodes it: an entry the schema refuses takes the route's page.
- `await entrySource(name, slug, data, { locale?, body?, create? })` from `kay/content` gives a folder entry's file as the editor wrote it, `{ file: { path, absolute, repoPath, text } }`, for the CMS to commit; kay writes nothing, and `absolute` stays on the server.
- An entry the folder holds keeps its file, its format and, without `body`, its body; a new one is Markdown when it has a body or the folder holds Markdown, JSON otherwise.
- An entry written as kay writes it reads back and is written again unchanged; otherwise YAML comments and quotes, JSON's indent, line endings, the blank line after the frontmatter and the body's trailing newlines come back as kay writes them.
- A file that does not parse is written over: a JSON or YAML one holds the data given alone, a key the editor did not send lost, and a Markdown one keeps the body `entries()` from `kay/content` gave unless `body` is given.
- It resolves `{ issues }`, as `showDraft` reports them, when the entry fails the collection, its slug names another file (a part empty, `.`, `..` or hidden, or a new file `a/index`, which reads back as `a`, so the entry is written as `a`; a localized collection takes no new `index`, as `en/index` reads back as no entry of a locale; `showDraft` refuses the same), its locale is one the site does not serve, its data is a list or a plain value rather than an object of fields, a `body` goes to a JSON or YAML file, or `create: true` names an entry the folder holds, a check as it is called, so the CMS commits a new file failing when its path exists.
- It throws for a loaded collection or a folder outside the repository.
- `await entryFile(name, slug, { locale? })` from `kay/content` gives the file a folder entry is read from, `{ file: { path, absolute, repoPath } }`, the paths of the file the editor's entry is written to, without its text, for the CMS to delete.
- It resolves `{ issues }` for a slug or locale naming no entry, and throws for a loaded collection or a folder outside the repository.
- `await saveEntry(name, { slug, locale?, data, body? }, { create? })` from `kay/content` hands a loaded entry to its loader's `save` once the collection accepts it, its data an object of fields, then reads the collection afresh, resolving `{}` or `{ issues }`.
- `create: true` resolves a `slug` issue for an entry the loader gives, and hands `save` `create: true`, which throws for an entry another process created since, the error reaching the caller.
- `await removeEntry(name, slug, locale?)` from `kay/content` calls its `remove` for an entry the loader gives, resolving `{}`, or `{ issues }` for a slug or locale naming none.
- A loaded slug may hold any part but `.` and `..` on either slash, `/about` say.
- Both throw for a folder collection or a loader without the method; a collection's saves and removes run in the process one at a time, in the order they are called, two of one entry keeping the later, and of two creates of one entry the second resolving the `slug` issue.
