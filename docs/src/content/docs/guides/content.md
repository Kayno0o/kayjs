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

## A page per entry

A page named after the slug reads one entry and prerenders a page for each of them.

```kay
--- server
// src/routes/blog/[slug].kay
import { posts } from '../../content.config'

export const page = { prerender: posts }

const post = await posts.get(ctx.params.slug) ?? ctx.notFound()
const { Content } = post
---
h1 {post.data.title}
article
  Content
```

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

<ReadMore href="/llms/content#pagination">How links follow the locale, `base` and `trailingSlash`, and how localized collections count pages, are in the full content reference.</ReadMore>

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

You can set `highlight`, `headingLinks`, `readingSpeed` and `imageSizes` once for every collection, under `markdown` in `kay.config.ts`. A collection's own option of the same name wins. `headingLinks: false` leaves a heading's text without a link to itself.

```ts
export default defineConfig({
  markdown: { highlight, headingLinks: false, readingSpeed: 200 },
})
```

Images with a relative path, `![A cat](./cat.png)`, work in the body too, when the file is inside the collection's folder. They load like an imported image, with a `srcset` of the widths in `images.widths`, `width`, `height` and lazy loading.

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

Add `format: 'atom'` for an Atom feed. `limit` is how many of the newest items it holds, 20 by default. `description` and `author` fill the feed's header, and Atom needs an author, so it uses the title when you set none. Return `undefined` from `item` to leave an entry out. Item links and guids are written as `trailingSlash` writes the page's address, so they match its canonical URL.

A link in a layout lets readers find the feed, and `kay check` accepts it when the path is written out.

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
| `load({ preview })` | Gives the entries as `{ slug, data, body }` or `{ slug, data, html }`. `body` is Markdown, `html` is rendered as it is. `preview` is true in preview mode and in development |
| `ttl` | How long the entries are served before the next read refreshes them in the background. Without it they are kept until `invalidate()` or a restart |
| `store` | A `sqliteCache(path)` that keeps them across restarts and lets `invalidate()` reach every process sharing it |
| `save(entry)`, `remove(entry)` | Write an entry back to the CMS, for a CMS editing the collections |

`data` is read against the schema, with defaults filled in and dates decoded. An entry the schema refuses, or one with no slug or a slug another entry has, fails the read and names every problem. The next read loads again.

`news.invalidate()` refreshes it, and every prerendered page that read it. Call it from a webhook in an API route. That one line is the whole webhook.

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

Each Markdown entry compiles once, and the result is kept in `.kay/cache/content`. A change to an entry recompiles that entry only. A change to a module the content config imports recompiles every entry when the collection has a highlighter.

A highlighter whose output changes with no change to its source needs that folder cleared. That is a new theme passed in, or a `.kay` or JSON file it reads. Only `.ts` and `.js` modules are watched.

`kay build` compiles every collection into `.kay/client/content`, and production reads that instead of the files.

## Markdown in an island

`markdownHtml` from `kay/markdown` renders Markdown a user writes as sanitized HTML. Use it for an editor's preview or a chat reply streaming in. Tables, images and task lists are kept, and scripts and handlers are dropped.

```kay
---
import { markdownHtml } from 'kay/markdown'

const text = signal('')
---
textarea(aria-label="Note" value={text()} onInput={e => text.set(e.currentTarget.value)})
div(innerHTML={markdownHtml(text())})
```

The server renders it with Bun.markdown and the island with marked, and both write the same HTML. Only the islands importing it load marked, about 15 KB gzipped.

It is sync, so it can run again on every chunk of a stream. Headings come out plain, with no id or anchor.

<ReadMore href="/llms/content#rendering-markdown">The few cases where the island and the server differ, and how the island stays fast on hostile input, are in the full content reference.</ReadMore>

## Preview mode

Set `preview: { secret }` in `kay.config.ts` to let an editor see drafts on the live site through a signed link.

Edit mode is preview mode for a CMS that edits content on the page. Enter it with `enterPreview(ctx, { edit: true })` or `previewUrl(path, { edit: true })`. `editing()` from `kay` tells whether the page is in it.

In edit mode the page marks the markup each field and body renders, so the CMS can find them. An extension names its editor island with `editor`, and `showDraft(entries)` from `kay/edit` shows the page with the entries the editor has not saved.

<ReadMore href="/llms/content-cms#preview-mode">The signed link, which fields get marked and which do not, the editor island and what each special page renders are in the full content reference.</ReadMore>

## A CMS editing the collections

A CMS that runs in your app's server reads the collections with `collections()` and `entries(name)` from `kay/content`. They give each collection's schema as JSON Schema, its folder, its draft field and its entries, drafts included.

`entrySource(name, slug, data)` gives a folder entry's file as the editor wrote it, for the CMS to commit. Kay writes no file. For a loader, `saveEntry` and `removeEntry` hand the entry to the loader's `save` and `remove`, after checking it against the collection.

These give drafts and files to whoever calls them, so serve them behind a guard or `editRequested(request)`.

<ReadMore href="/llms/content-cms#a-cms-editing-the-collections">Paged reads, counting without running a loader, `create: true`, `entryFile`, field markers such as `imageField()` and every failure shape are in the full content reference.</ReadMore>

<ReadMore href="/llms/content">The Markdown renderer's edge cases, the collection options and the CMS helpers are in the full content reference.</ReadMore>
