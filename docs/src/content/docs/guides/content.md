---
title: Content collections
order: 3
description: Read Markdown and data files against a schema, and render a page per entry.
---

A collection is a folder of Markdown, JSON or YAML files, each checked against a schema. Declare collections in `src/content.config.ts`.

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

Each folder is relative to that file, so `content/posts` is `src/content/posts`. An entry that does not match the schema fails `kay check` at the field's line, and fails the build.

## Listing and reading entries

`all()` gives every entry in the `sort` order. `get(slug)` gives one, or `undefined`. Both are typed from the schema.

```kay
--- server
// src/routes/blog/index.kay
import { posts } from '../../content.config'

const entries = await posts.all()
---
ul
  for post of entries
    li: a(href={`/blog/${post.slug}`}) {post.data.title}
```

An entry has `slug`, `data`, `headings` for a table of contents, and `Content`, the component rendering its body.

Entries marked as drafts show in development only. That means under `kay dev`, or when the server's `dev` option is on, whatever `NODE_ENV` says.

An entry also has `excerpt`, its first paragraph as plain text, or every paragraph before a `<!-- more -->` line you write to mark the end of the lead.

It also has `body`, the Markdown as written without its frontmatter, and `html`, what `Content` renders, as a string for a feed, a search index or an API.

A paragraph inside a component, a quote (nested ones too) or a list item is not in the excerpt. The excerpt, `body` and `html` are worked out the first time you read them, so entries you never read them on cost nothing: a built server keeps the bodies in a file of its own and opens it only when one is read.

An entry also has `words` and `readingTime`, counted from the text the page shows. `readingTime` is in minutes, at 230 words a minute (`markdown.readingSpeed` in `kay.config.ts` changes it), and never less than 1 for a body with words.

```kay
p {post.readingTime} min read
```

A data file has neither.

<ReadMore href="/llms/content#reading-entries">What the word count includes and leaves out, and the `file` of an entry, are in the full content reference.</ReadMore>

### Showing edits in open tabs

Add `live: true` to a collection and every open page that read it shows an `invalidate()` right away, in every tab. A save or a removal from the CMS drops the entries, so the other tabs show it too.

```ts
export const news = collection('content/news', { schema, live: true })
```

The page is rendered for each request then, so `kay build` cannot keep it as a file. See [Data from the cache](/guides/live-and-realtime#data-from-the-cache).

## Scheduling an entry

Name a date field with `publishAt` in the collection, beside `draft`:

```ts
export const posts = collection('src/content/posts', {
  schema: s.Object({ title: s.String(), publishAt: s.Optional(s.Date()) }),
  publishAt: 'publishAt',
})
```

An entry whose date is still ahead is held back as a draft is: it is left out of `all()`, `get()`, the sitemap, the feed and the pages built from it. At that time it appears by itself. An entry with no date, or a date in the past, is published. A draft stays a draft whatever its date.

The date is read in UTC, never in the server's time zone. `2026-10-20` means midnight UTC. To say an hour in your own zone, write the offset: `2026-10-20T08:00:00+02:00`. A date with an hour needs the `Z` or an offset, a time with neither is refused.

Your app writes no cron, job or webhook. Each server process watches the dates of its own collections. When one passes, it builds again the pages that read the collection, and the sitemap.

A server that was down at that time does it as it starts. If your data source fails then, the server starts anyway, logs the error once and reads the dates again every minute until it works. Several replicas each do it for themselves. A cache in front of the feed, which is kept for an hour, may show the old one a while longer.

The page of the new entry itself was not listed when the site was built, so it is rendered on each visit until the next build.

A [static export](/guides/static-export) has no server, so it cannot change by itself. Build it again on a schedule, for example from CI, and the entry appears in the next build.

A name that is not an `s.Date()` field is a type error in `kay check`, and the server refuses to start.

## Ending an entry

Name a second date field with `unpublishAt` and the entry takes itself down at that time, as `publishAt` brings it up:

```ts
export const offers = collection('src/content/offers', {
  schema: s.Object({ title: s.String(), endsAt: s.Optional(s.Date()) }),
  unpublishAt: 'endsAt',
})
```

From that time the entry is left out of `all()`, `get()`, the sitemap, the feed and the pages built from it. An entry with no end date never ends. The two options work together, so an entry can have a window. `kay dev` and preview mode keep showing it. The date is read like the publish date, in UTC unless you write an offset.

The server builds again the pages that read the collection when the date passes, the same way as for `publishAt`, and does it as it starts when it was down at that time. The page of the ended entry is rendered again too, so its URL answers what its code does when `get()` finds nothing: `?? ctx.notFound()` answers 410 Gone for an ended entry (404 for a slug that never existed, and for a draft or an entry not yet published), and `?? ctx.redirect('/offers')` sends visitors to the list.

A redirect from the path, in `redirects` or added from the Missing pages screen, wins over the 410, and a visit to an ended entry is listed on that screen so an editor can add one. A `ctx.notFound()` that comes after the page read an ended entry answers 410 too, even for something unrelated, and a 410 your own code answers can be redirected the same way.

A name that is not an `s.Date()` field is a type error in `kay check`, and the server refuses to start. kayjs-cms shows `Ends` or `Ended` beside the entry's date field and can clear the date.

## A page per entry

A page named after the slug reads one entry. When the collection has a `route` (see [Entry URLs](#entry-urls)) that is the page of that route, and it prerenders a page for each entry and lists them in the sitemap with nothing more to write.

```kay
--- server
// src/routes/blog/[slug].kay
import { posts } from '../../content.config'

const post = await posts.get(ctx.params.slug) ?? ctx.notFound()
const { Content } = post
---
h1 {post.data.title}
article
  Content
```

A collection without a `route` lists its entries in the page's `page` export instead, `export const page = { prerender: posts }`, which also wins over the route.

A page at the route that reads the cookies, the query, a session or preview mode cannot be built once. Set `export const page = { prerender: false }` and it renders for each request, and the sitemap leaves its entries out.

The page's head comes from the entry too: its `title` and `description` fields become the title and the description meta, and a `date`, `publishedAt` or `published` field (or the field named by `publishAt`, which must be a `Date` field: a text date gets nothing) makes `og:type` an `article` with an `article:published_time`.

A `modified` option naming another `Date` field adds `article:modified_time` and gives the sitemap a `lastmod` for each entry's URL.

`modified: 'mtime'` or `modified: 'git'` needs no field. `'mtime'` uses the file's time and `'git'` the author date of the file's last commit, read with one `git log` for the whole folder. A file git does not know, such as an untracked one or any file outside a repository, falls back to its time. The date is also `entry.modified`. A shallow clone has one commit, so build with the full history when you use `'git'`. A loader's entries have no file, so they get no date.

An entry with no `description` takes its excerpt, cut at a word under 160 characters, so a page gets a description without anyone writing one.

Tags the page writes in a `head` block replace them, and a field the entry lacks leaves the layout's tag.

A slug with a slash, like `guides/intro`, needs a catch-all page, `[...slug].kay`.

An entry can set its own slug with a `slug` field in its frontmatter, so a translated post gets a URL in its own language. It is a path of non-empty parts, with no `.` or `..` part, backslash, `?` or `#`, and two entries may not share one. In a localized collection the slug stays under the locale's folder, and `translations` pairs entries by equal slugs.

Give translations that set their own slugs a `translationKey` field with the same value, such as `translationKey: hello`, to pair them. Two entries of one locale cannot share a key, and a slug counts as one, so the collection fails on either. A schema that does not allow extra fields needs `slug` and `translationKey` listed.

## Pages of a list

`paginate` splits a collection, an array, or a function returning one into pages. Use it in a page whose one param is optional.

```kay
--- server
// src/routes/blog/[[page=integer]].kay
import { paginate } from 'kay/content'
import { posts } from '../../content.config'

const blog = paginate(posts, 10)

export const page = { prerender: blog }

const list = await blog.page(ctx.params.page) ?? ctx.notFound()
--- script
import Pagination from '@kaynooo/kayjs-ui/pagination.kay'
---
for post of list.items key={post.slug}
  a(href={`/blog/${post.slug}`}) {post.data.title}
Pagination(of={list})
```

`list` holds `items`, `page`, `pages`, the `prev` and `next` links, and `href(n)` for any page. The links are `undefined` at the ends.

The first page is `/blog`, the others `/blog/2`, `/blog/3`. `/blog/1`, a page past the last and anything but a number give `undefined`, a 404.

As the `prerender` or `sitemap` key of `page`, it lists every page, `kay build --static` included. [Pagination](/ui/pagination) from kayjs-ui draws the links.

<ReadMore href="/llms/content-markdown-to-caching#pagination">How links follow the locale, `base` and `trailingSlash`, and how localized collections count pages, are in the full content reference.</ReadMore>

## Components in Markdown

List the components a collection may use, then write them in the Markdown with a capital, as in a template.

```ts
import Callout from './components/callout.kay'

export const posts = collection('content/posts', {
  schema,
  components: { Callout },
})
```

```md
<Callout type="warn">

Back up first.

</Callout>
```

An interactive component renders as an island. A page rendering an entry's `Content` links the stylesheets those components import.

A component the collection does not name fails `kay check` and the build. So does an attribute that would put its text on the page as markup, such as `innerHTML`.

A capitalized tag kay cannot read fails too, at its line, rather than showing on the page as text. That is a quote or a brace never closed, or text after a JSON value, as in `rows={[1]}}`. JSON values may nest to any depth. In prose, a `<` before a capital letter reads as a tag once it holds an attribute value or a `>` follows it in the paragraph, code spans left out, so write `&lt;` for a literal one.

Without a later `>`, a tag such as `<Chart stray` at the end of a body stays text, escaped. A blank line ends the paragraph, so a tag cut by one is text too. A blockquote's `>` markers are not a later `>`, and a tag inside a quote may continue on the next quoted lines.

## Highlighting code

You can set `highlight`, `transform`, `preprocess`, `containers`, `footnotes`, `headingLinks`, `readingSpeed` and `imageSizes` once for every collection, under `markdown` in `kay.config.ts`. A collection's own option of the same name wins. `headingLinks: false` leaves a heading's text without a link to itself.

```ts
export default defineConfig({
  markdown: { highlight, headingLinks: false, readingSpeed: 200 },
})
```

Images with a relative path, `![A cat](./cat.png)`, work in the body too, when the file is inside the collection's folder. They load like an imported image, with a `srcset` of the widths in `images.widths`, `width`, `height`, lazy loading and their average color until they load ([Responsive images](/essentials/styling-and-assets#a-color-while-an-image-loads)).

Their `sizes` is `100vw`, which `imageSizes` in `markdown` or on a collection changes, and a tag's own `sizes="..."` wins for that image. A tag that sets its own `width`, `height` or `srcset`, an SVG, an absolute path or a URL is left as written.

Without a highlighter, a code block is `<pre><code class="language-ts">`. Give the collection a `highlight` function and it returns the whole `<pre>` instead, such as Shiki's `codeToHtml`. It runs when the entries compile, at build time, and the `markdown.highlight` of `kay.config.ts` also runs on the server for the code of a chat answer, so it must work at runtime too.

```ts
import { codeToHtml } from 'shiki'

export const posts = collection('content/posts', {
  schema,
  highlight: (code, language) => codeToHtml(code, { lang: language ?? 'text', theme: 'github-dark' }),
})
```

A fence may name a language the highlighter does not know, so the function falls back for it rather than throwing.

`highlightCode(code, language, { highlight })` from `kay/content` renders one block the same way, for a page that shows a snippet that is no entry. It resolves with HTML that is safe to render.

```kay
--- server
import { highlightCode } from 'kay/content'
import { highlight } from '../highlight'

const snippet = await highlightCode('const a = 1', 'ts', { highlight })
---
div(innerHTML={snippet})
```

`renderMarkdown(text, { highlight })` does the same for a whole text, such as a note, and resolves with `{ html, headings }`. Its HTML is the writer's, so a user's goes through `sanitizeHtml` before it is rendered.

A link in an entry's Markdown that leaves your site opens in a new tab, as it does in a template ([Links to other sites](/essentials/templates#links-to-other-sites)).

## Changing what Markdown renders

Three tools add what Markdown lacks, each set in `markdown` in `kay.config.ts` for every collection or on one collection, where it wins.

`containers: true` turns `:::note Title` ... `:::` into an `<aside class="admonition note">` with the title in a `<p class="admonition-title">`. What sits inside stays Markdown, paragraphs, lists and code blocks included, and containers nest. An opener nothing closes, or one inside a code fence, stays text. A container must start at the line's left edge, so one inside a list or a quote is not read.

`footnotes: true` turns `[^id]` into a numbered mark and `[^id]: text` into a list at the end of the entry, each item with a link back. A definition is its line and the indented lines under it, one paragraph. A reference without a definition stays as written, and a definition nothing refers to is dropped. So does one in code, in link text or in a heading.

The ids are `fn:1` and `fnref:1`, which no heading can have. Both are off by default, so existing content renders as before.

A `transform` gets the HTML an entry renders to and gives it back changed, for the rest: link, image and heading rewriting. Bun's `HTMLRewriter` edits it by selector:

```ts
export const docs = collection('content/docs', {
  schema,
  transform: (html, entry) => new HTMLRewriter()
    // Links to a sibling file become links to its page.
    .on('a', { element(link) {
      const href = link.getAttribute('href')

      if (href?.endsWith('.md'))
        link.setAttribute('href', `/docs/${href.slice(0, -3)}`)
    } })
    .on('img', { element(image) {
      image.setAttribute('loading', 'lazy')
    } })
    // A heading one level down, as the page already has its own `h1`.
    .on('h1, h2, h3, h4, h5', { element(heading) {
      heading.tagName = `h${Number(heading.tagName.slice(1)) + 1}`
    } })
    .transform(html),
})
```

`preprocess(markdown, entry)` does the same on the source, before components are read, for syntax of your own: what it writes can be a component tag or any Markdown.

Both run once as the entry compiles, so they cost nothing per request. The transform gets the HTML before the headings are read and code is highlighted: a heading it moves is listed at its new level, and the highlighter has the last word on code blocks, which it sees as `<pre><code class="language-ts">`.

A heading is `<h2 id="slug"><a href="#slug">Text</a></h2>`; keep that shape. Both can be async. The `entry` is `{ file, slug, locale }`, with the locale set for an entry of a localized collection. `file` is the entry's path from the project root, or `collection/slug` for a loader's.

A component written in the Markdown stands as a `<kay-component>` element in the transform's HTML. Leave them as they are: a transform that drops, adds or reorders one fails the entry. A hook that throws, or gives something other than text, fails it too, with an error naming the entry's file, and the error it threw as its `cause`.

The HTML you write is as raw as the Markdown's own. For a collection with a `load` function, whose bodies are sanitized unless it is `trusted`, the hooks run first and the result is sanitized, so the `class` of an admonition is dropped there.

An entry a loader gives as `html`, not `body`, skips them. A link you write to your own pages gets the base, as an authored one does. The CMS preview renders with the collection's hooks and switches too, though it sanitizes with its own list of what to keep, so a `class` may differ from the page's.

`renderMarkdown(text, { transform, preprocess, containers, footnotes })` renders a runtime text the same way, and takes the entry as `entry`, `{ file: 'renderMarkdown', slug: '' }` by default.

## Entry URLs

`route: '/blog/:slug'` on a collection gives each entry a typed `url`, so links and feeds write no path. Use `'/docs/*slug'` when a slug has folders.

```ts
export const posts = collection('content/posts', {
  schema,
  route: '/blog/:slug',
})
```

```kay
--- server
import { posts } from '../../content.config'

const entries = await posts.all()
---
for post of entries
  a(href={post.url}) {post.data.title}
```

`url` is the path as `route()` writes it, so kay puts the base and the page's locale on it as on any link.

A localized entry's `url` has its own slug, so `(await posts.translation(post, 'fr'))?.url` is the page of its translation, and on a page that read the entry with `get()`, `alternate('fr')` gives it too.

A dotted slug such as `v1.2` is a page, not a file; a link ending in a file's extension, such as `/blog/cover.png`, stays a file unless an entry has that slug, as `release.html` in a localized site, whose entries are read at startup and again when the collection is invalidated. A slug the route cannot write leaves its entry out, logged. The CMS reads the route before `url`.

The route has one param, the slug, and `kay check` reports a route no page matches, such as one with `src/routes/blog/[slug].kay` missing, a page listing the collection in `prerender` while another page serves the route, and two collections sharing one route. A collection with no `route` has no `url`. A `url` function next to a `route` is overridden by the route, and a feed item's `path` is still read.

## Feeds

Give a collection a `feed` and kay serves an RSS feed at its path, built from the newest items. Set `site` in `kay.config.ts` first, because feed links are absolute. The feed carries an ETag, so a reader that already holds the current version gets a short 304 instead of the whole file.

```ts
export const posts = collection('content/posts', {
  schema,
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

With a `route` on the collection, `item`, `title` and `path` in the items can all be left out: the feed links each entry's `url`, takes the title from the collection's `title` option, and reads each item's `title`, `description` (the entry's excerpt when it has none), `author`, `tags`, `image` and date from the entry's fields. See [Entry URLs](#entry-urls).

```ts
export const posts = collection('content/posts', {
  schema,
  route: '/blog/:slug',
  modified: 'updatedAt',
  feed: { path: '/blog/rss.xml', format: ['rss', 'json'], content: true },
})
```

`content: true` puts each entry's whole body in the feed, with its links written out in full. An item can also carry `categories`, an `image` and `updated`, which `modified` sets by default. `format` takes `'rss'`, `'atom'` or `'json'` (JSON Feed), or a list to serve several from one collection: the first at `path`, the others beside it with the extension replaced, `/blog/rss.json`.

Every page showing an entry of the collection links its feed in its head, one `link rel="alternate"` per format. A list page adds the same links with `export const page = { feed: posts }`, and `feed: false` leaves them out.

Add `format: 'atom'` for an Atom feed. `limit` is how many of the newest items it holds, 20 by default. `description` and `author` fill the feed's header, and Atom needs an author, so it uses the title when you set none. Return `undefined` from `item` to leave an entry out. Item links and guids are written as `trailingSlash` writes the page's address, so they match its canonical URL.

A link written by hand, in a layout for instance, passes `kay check` when the path is written out.

```kay
head
  link(rel="alternate" type="application/rss+xml" href="/blog/rss.xml" title="Blog")
```

## Entries per locale

On a site with `i18n`, `localized: true` keeps each entry in a folder named after its locale. `posts/fr/hello.md` and `posts/en/hello.md` are one entry, slug `hello`, in two languages.

`all()` and `get()` read the request's locale and fall back to the default locale's entry. `entry.locale` says which one was read. The feed is served once per locale.

`kay i18n translate fr` from the kayjs-ai library writes the entries `fr` lacks, as drafts (see [kayjs-ai](/libraries/kayjs-ai#translate-what-is-missing)).

`entry.translations` lists the locales that have an entry with the slug. Use it for a language switcher that shows only the languages a post exists in. `posts.translation(post, 'fr')` gives the `fr` entry paired with it, whatever slug that one set, so the switcher can link to it.

```kay
for code of post.translations ?? []
  a(href={alternate(code)} hreflang={code}) {code}
```

Either method takes a locale as its last argument. Outside a request, `all()` gives every locale's entries and `get(slug, locale)` reads that locale's entry alone, with no fallback.

## Entries that point at entries

`reference('authors')` makes a field hold the slug of an entry of the `authors` collection. It works in a list, an object or a block too.

`kay check` and `kay build` fail on a slug that collection has no entry for. The message names the file and the line of the field. In a localized collection, an entry of any locale counts. A save through a CMS is refused the same way, at the field's path.

`resolve(slug, collection)` reads the entry that a field points at. It gives undefined for no slug or a hidden entry, and the entries found for a list of slugs.

```kay
--- server
import { resolve } from 'kay/content'
import { authors, posts } from '../../content.config'

const post = await posts.get(ctx.params.slug) ?? ctx.notFound()
const author = await resolve(post.data.author, authors)
---
p {author?.data.name}
```

A collection filled by a loader is not read by `kay check`, so a reference to it is checked only when an entry is written. The check accepts a reference to a draft, and `resolve` returns undefined for it until the entry is published.

## Collections from a CMS

When the entries live in a headless CMS, an API or a database, pass a loader instead of a folder. The collection is read, typed and used the same way, and is cached for the `ttl`.

```ts
export const news = collection({
  name: 'news',
  load: async () => (await listPosts()).map(post => ({
    slug: post.slug,
    data: { title: post.title },
    html: post.content,
  })),
  ttl: '15m',
}, {
  schema: s.Object({ title: s.String() }),
})
```

The loader takes more than `load`.

| Option | Does |
| --- | --- |
| `load({ preview })` | Gives the entries as `{ slug, data, body }` or `{ slug, data, html }`. `body` is Markdown, `html` is HTML. Both are sanitized unless the collection is `trusted: true`. `preview` is true in preview mode and in development |
| `ttl` | How long the entries are served before the next read refreshes them in the background. Without it they are kept until `invalidate()` or a restart |
| `store` | A `sqliteCache(path)` that keeps them across restarts and lets `invalidate()` reach every process sharing it |
| `save(entry)`, `remove(entry)` | Write an entry back to the CMS, for a CMS editing the collections. The `data` of `save` is typed from the collection's `schema`, with defaults filled in and dates as text, so it needs no cast |

`data` is read against the schema, with defaults filled in and dates decoded. An entry with no slug or a slug another entry has fails the read and names every problem. The next read loads again.

An entry the schema refuses is left out instead, and the server logs a warning naming it and each field that is wrong, with its whole path, such as `packs.0.price`. The other entries still load, so one old row does not break every page that reads the collection. The editor still sees the entry in the CMS, can open it, and the page shows it again once it is saved fixed.

### When the schema changes

Entries a database holds keep the shape they had when they were saved. When you change the schema, say how to carry them over with `migrations`. Each step takes an entry's data and gives it back in the new shape.

```ts
import { collection, convertField, renameField, setField } from 'kay/content'

export const packs = collection(loader, {
  schema: s.Object({ title: s.String(), price: s.Integer(), visible: s.Boolean() }),
  migrations: [
    renameField('name', 'title'),
    convertField('price', value => typeof value === 'string' ? Number.parseInt(value, 10) : value),
    setField('visible', true),
  ],
})
```

The steps run, in order, only on an entry the schema refuses, and stop once it accepts the entry. Write each step so that it leaves data already in the new shape alone. `renameField` does nothing when the new field exists, `setField` fills only a missing field and `convertField` only a present one.

An entry that changed is given to the loader's `save` once, so the next read finds it in the new shape and nothing runs again. An entry of a folder is migrated when it is read and its file stays as it is until a CMS saves it, or until you run `kay migrate content`, which rewrites the files a step carried over. Defaults fill nested objects and list items as well as the top-level fields.

To keep two entries from sharing a value, such as a code, wrap the field in `unique()` from `kay/content`: a save that repeats another entry's value is refused with an issue on that field.

`news.invalidate()` refreshes it, and every prerendered page that read it. Call it from a webhook in an API route. That one line is the whole webhook.

A loader often reads content its author did not write, so a loaded `body` and `html` are sanitized as a user's Markdown is: formatted text, links, relative URLs, images and tables stay, and scripts, handlers, styles, iframes and `javascript:` links are dropped. Only a link written with an http(s) URL gets `rel="nofollow ugc"`, so one to your own site by its full address has it too.

A folder's files are the author's own and keep their raw HTML, and `kay check` reports `trusted` on a folder collection.

Pass `trusted: true` in the collection's options when the loader returns content written by people you trust, such as your own CMS editors, to keep its HTML as it is.

`kay build` does not keep a page over a loader on its own, since a loader may read a database and `ttl` refreshes the entries without telling the page. Add `prerender: true` to the page to prerender it anyway. The webhook then refreshes it.

### Counting without loading

A CMS screen that lists collections should not run `load` for every entry just to show a number. Give the loader `count` and `get`, and the CMS helpers `collections()`, `collectionInfo()` and `entries(name, { slug })` call them instead.

```ts
export const news = collection({
  name: 'news',
  load: async () => (await listPosts()).map(toEntry),
  count: async () => countPosts(),
  get: async place => toEntry(await findPost(place)),
  body: false,
}, { schema })
```

`count({ preview })` says how many entries `load` would give. `get(place, { preview })` gives the one entry at a place, which is its slug, or the locale and the slug as `fr/launch` in a localized collection, or `undefined`. `body: false` says the entries hold `html` and no Markdown, which an editor reads without loading any.

<ReadMore href="/llms/content-cms#loaded-collections">Every loader option, `create` on a new entry and what a failing read reports are in the full content reference.</ReadMore>

### Caches

Each Markdown entry compiles once, and the result is kept in `.kay/cache/content`. A change to an entry recompiles that entry only. A change to a module or a JSON file the content config imports recompiles every entry when the collection has a highlighter, a `transform` or a `preprocess`, and so does a change to the hook's own source, to the switches, and, for a hook, to the nearest `bun.lock` above the project up to its git root, so a dependency upgrade shows.

A hook given as a bound function is refused, as its source cannot be read: write an arrow function calling it. The Markdown bodies of a collection with a `load` function are kept there too, in one file for the collection.

A highlighter, a `transform` or a `preprocess` whose output changes with no change to its source needs that folder cleared. That includes one reading `process.env` or a file at run time. That is a new theme passed in, or a `.kay` or other file it reads. Only `.ts`, `.js` and `.json` files are watched.

`kay build` compiles every collection into `.kay/client/content`, and production reads that instead of the files.

## Markdown in an island

`markdownHtml` from `kay/markdown` renders Markdown a user writes as sanitized HTML. Use it for an editor's preview or a chat reply streaming in. Tables, images and task lists are kept, and scripts and handlers are dropped. Each task list checkbox sits in a `label` with its item's text, in every Markdown body, so a screen reader names it.

```kay
---
import { signal } from 'kay'
import { markdownHtml } from 'kay/markdown'

const text = signal('')
---
textarea(aria-label="Note" value={text()} onInput={e => text = e.currentTarget.value})
div(innerHTML={markdownHtml(text())})
```

Text set through `innerHTML`, from `markdownHtml`, `renderMarkdown` or `sanitizeHtml`, shows unstyled under Tailwind's preflight. With kayjs-ui, give its element the `kui-prose` class: headings, lists, links, quotes, code and tables take the theme's look, and a wide table or code block scrolls inside it.

A link leaving your site opens in a new tab with `rel="nofollow ugc noopener"`, the server and the island alike, unless you set `links: { outside: 'same-tab' }`.

The server renders it with Bun.markdown and the island with marked, and both write the same HTML. Only the islands importing it load marked, about 15 KB gzipped, and only when they first render Markdown the server did not draw: until it arrives the island shows the text as written, then the formatted one. Call it in a template or an effect, which runs again once marked has loaded; in a click handler, `await markdownReady()` from `kay/markdown` first.

An island about to stream Markdown starts the load early with `void markdownReady()`, as kayjs-ai's Chat does when the visitor sends.

While an island hydrates, the text as written stands in for markup the server drew formatted, and the island leaves that markup in place, even where the same text is written again after hydration: marked loads once the text changes or is written again, so a page whose Markdown never changes never fetches it.

A component that changes what `markdownHtml` returned before writing it, such as linking words in it, returns it as it is when `isHeldMarkdown(html)`, from `kay/markdown` too, is true; on the server it is always false.

Until marked arrives, the text as written shows no code apart. A component linking words in the HTML reads them from the Markdown itself while `markdownLoaded()`, from `kay/markdown`, is false: read in a template or an effect, it runs again once marked has loaded, and it loads nothing. On the server it is always true.

It is sync, so it can run again on every chunk of a stream. Headings come out plain, with no id or anchor.

<ReadMore href="/llms/content-markdown-to-caching#rendering-markdown">The few cases where the island and the server differ, and how the island stays fast on hostile input, are in the full content reference.</ReadMore>

## Preview mode

Set `preview: { secret }` in `kay.config.ts` to let an editor see drafts on the live site through a signed link.

To share one draft, give `previewUrl` the entry: `previewUrl('/news/draft', { entry: { collection: 'news', slug: 'draft' } })`. The link opens the entry's own page with a signed `kay_preview` in its query, valid an hour or the `ttl` you give. It shows that draft and nothing else. The visitor is put in no mode and gets no cookie, so every other page and entry stays as published.

The link works on that page only, and stops working once it expires, when the entry is renamed or when you change the secret. You cannot cancel one earlier. A link for one locale shows no other locale's draft. kayjs-cms offers it as a Share preview button.

Edit mode is preview mode for a CMS that edits content on the page. Enter it with `enterPreview(ctx, { edit: true })` or `previewUrl(path, { edit: true })`. `editing()` from `kay` tells whether the page is in it.

In edit mode the page marks the markup each field and body renders, so the CMS can find them. That holds in a component the entry was handed down to as well as in the page itself. An extension names its editor island with `editor`, and `showDraft(entries)` from `kay/edit` shows the page with the entries the editor has not saved. An entry that fails its schema is left out and shows its saved text, so one bad field does not stop the preview of the others.

A field the page shows changed (`toUpperCase()`, a joined list), in an island or in a frozen object has nothing to click, and neither has one it reads only for a condition or a class, so the editor is given them as `unclickable` and kayjs-cms names them above the entry's form.

<ReadMore href="/llms/content-edit#edit-mode">The signed link, which fields get marked and which do not, the editor island and what each special page renders are in the full content reference.</ReadMore>

## A CMS editing the collections

A CMS that runs in your app's server reads the collections with `collections()` and `entries(name)` from `kay/content`. They give each collection's schema as JSON Schema, its folder, its draft field and its entries, drafts included.

`entrySource(name, slug, data)` gives a folder entry's file as the editor wrote it, for the CMS to commit. Kay writes no file. For a loader, `saveEntry` and `removeEntry` hand the entry to the loader's `save` and `remove`, after checking it against the collection. `saveEntries` hands several to its `saveMany` at once, all or none.

`translations(name)` tells a localized collection's translations without reading every entry again: a map of each translation key to the slug written in each locale. It is built once, and rebuilt after a save or remove, an `invalidate()`, the loader's `ttl`, or a change to a folder's files.

These give drafts and files to whoever calls them, so serve them behind a guard or `editRequested(request)`.

<ReadMore href="/llms/content-cms#a-cms-editing-the-collections">Paged reads, counting without running a loader, `create: true`, `entryFile`, field markers such as `imageField()` and every failure shape are in the full content reference.</ReadMore>

<ReadMore href="/llms/content">The Markdown renderer's edge cases, the collection options and the CMS helpers are in the full content reference.</ReadMore>
