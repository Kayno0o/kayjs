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

An entry also has `words` and `readingTime`, counted from the text the page shows. `readingTime` is in minutes, at 230 words a minute, and never less than 1 for a body with words.

```kay
p {post.readingTime} min read
```

A data file has neither.

<ReadMore href="/llms/content#reading-entries">What the word count includes and leaves out, and the `file` of an entry, are in the full content reference.</ReadMore>

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

A capitalized tag kay cannot read fails too, at its line, rather than showing on the page as text. That is a quote or a brace never closed, or text after a JSON value, as in `rows={[1]}}`. JSON values may nest to any depth. In prose, a `<` before a capital letter reads as a tag once a `>` follows it in the paragraph, code spans left out, so write `&lt;` for a literal one.

Without a later `>`, a tag such as `<Chart stray` at the end of a body stays text, escaped. A blank line ends the paragraph, so a tag cut by one is text too.

## Feeds

Give a collection a `feed` and kay serves an RSS feed at its path, built from the newest items. Set `site` in `kay.config.ts` first, because feed links are absolute.

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

## Entries per locale

On a site with `i18n`, `localized: true` keeps each entry in a folder named after its locale. `posts/fr/hello.md` and `posts/en/hello.md` are one entry, slug `hello`, in two languages.

`all()` and `get()` read the request's locale and fall back to the default locale's entry. `entry.locale` says which one was read. The feed is served once per locale.

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

`news.invalidate()` refreshes it, and every prerendered page that read it. Call it from a webhook in an API route. That one line is the whole webhook.

`kay build` does not keep a page over a loader on its own, since a loader may read a database and `ttl` refreshes the entries without telling the page. Add `prerender: true` to the page to prerender it anyway. The webhook then refreshes it.

<ReadMore href="/llms/content-cms#loaded-collections">Counting entries and fetching one without running `load`, so a CMS can list a collection cheaply, are in the full content reference.</ReadMore>

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

<ReadMore href="/llms/content">Syntax highlighting, `renderMarkdown`, the caches, atom feeds and the loader options are in the full content reference.</ReadMore>
