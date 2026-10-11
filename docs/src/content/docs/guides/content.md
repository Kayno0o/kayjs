---
title: Content collections
order: 3
description: Read Markdown and data files against a schema, and render a page per entry.
---

A collection is a folder of Markdown, JSON or YAML files, each checked against a schema. Declare them in `src/content.config.ts`, each folder relative to that file, so `content/posts` is `src/content/posts`:

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

An entry that does not match the schema fails `kay check` at the field's line, and fails the build.

## Listing and reading entries

`all()` gives every entry in the `sort` order, `get(slug)` gives one or `undefined`. Both are typed from the schema. `src/routes/blog/index.kay`:

```kay
--- server
import { posts } from '../../content.config'

const entries = await posts.all()
---
ul
  for post of entries
    li: a(href={`/blog/${post.slug}`}) {post.data.title}
```

An entry has `slug`, `data`, `headings` (for a table of contents) and `Content`, the component rendering its body. Entries marked as drafts show in development only: under `kay dev`, or when the server's `dev` option is on, whatever `NODE_ENV` says.

## A page per entry

`src/routes/blog/[slug].kay` reads one entry and prerenders a page for each of them:

```kay
--- server
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

`paginate` splits a collection, an array, or a function returning one into pages, for a page whose one param is optional:

```kay
--- server
// src/routes/blog/[[page=integer]].kay
import { paginate } from 'kay/content'
import { posts } from '../../content.config'

const blog = paginate(posts, 10)

export const page = { prerender: blog }

const list = await blog.page(ctx.params.page) ?? ctx.notFound()
---
for post of list.items key={post.slug}
  a(href={`/blog/${post.slug}`}) {post.data.title}
Pagination(of={list})
```

`list` holds `items`, `page`, `pages`, the `prev` and `next` links, undefined at the ends, and `href(n)` for any page. The first page is `/blog`, the others `/blog/2`, `/blog/3`; `/blog/1`, a page past the last and anything but a number give `undefined`, a 404. As the `prerender` or `sitemap` key of `page`, it lists every page, `kay build --static` included. Links follow the request's locale, the site's `base` and `trailingSlash`. A localized collection counts each locale's entries, so a locale with more of them has more pages, each listed in that locale alone. [Pagination](/ui/pagination) from kayjs-ui draws the links.

## Components in Markdown

List the components a collection may use, and write them in the Markdown with a capital, as in a template:

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

An interactive component renders as an island. A page rendering an entry's `Content` links the stylesheets those components import, for every collection its `--- server` fence imports. A component the collection does not name fails `kay check` and the build.

## Feeds

Give a collection a `feed` and kay serves an RSS feed at its path, built from the newest items. It needs `site` set in `kay.config.ts`, because feed links are absolute.

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

On a site with `i18n`, `localized: true` keeps each entry in a folder named after its locale: `posts/fr/hello.md` and `posts/en/hello.md` are one entry, slug `hello`, in two languages. `all()` and `get()` read the request's locale, falling back to the default locale's entry, `entry.locale` says which one was read, and the feed is served once per locale.

## Collections from a CMS

When the entries live in a headless CMS, an API or a database, pass a loader instead of a folder. The collection is read, typed and used the same way, and is cached for the `ttl`:

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

`news.invalidate()` refreshes it, typically from a webhook in an API route.

## Markdown in an island

`markdownHtml` from `kay/markdown` renders Markdown a user writes, such as an editor's preview or a chat reply streaming in, as sanitized HTML: tables, images and task lists kept, scripts and handlers dropped.

```kay
---
import { markdownHtml } from 'kay/markdown'

const text = signal('')
---
textarea(aria-label="Note" value={text()} onInput={e => text.set(e.currentTarget.value)})
div(innerHTML={markdownHtml(text())})
```

The server renders it with Bun.markdown, the island with marked, writing the same HTML; only the islands importing it load marked, about 15 KB gzipped. It is sync, so it can run again on every chunk of a stream. Headings come out plain, with no id or anchor.

The two differ only where Bun.markdown is odd: a named reference such as `&copy;` stays written in the island, which the browser shows the same; a URL with parentheses or a `"` in its path, and one still being typed, without a dot yet or ending in `=`, is a link in the island alone; a task item whose text the next line underlines as a heading is not a task in the island. The island also keeps marked linear on hostile input: an emphasis or a strikethrough closes within 1,000 characters there, and text past 100,000 characters, or nested too deep for marked, shows as it is written.

## Preview mode

Setting `preview: { secret }` in `kay.config.ts` lets an editor see drafts on the live site through a signed link, see [the full reference](/llms/content#preview-mode). Edit mode, entered with `enterPreview(ctx, { edit: true })` or `previewUrl(path, { edit: true })`, is preview mode for a CMS editing content on the page, which `editing()` from `kay` tells: the page then marks the markup each field and body renders, `data-kay-field`, `data-kay-list` and `data-kay-body` attributes or comments around mixed text, for the CMS to find on the page. A field is found by its value, so one the template transforms, `toUpperCase()` or a formatted date, goes unmarked, and islands stay unmarked; a field's text read for a condition and never rendered marks the next equal text as that field, and a number is marked only when rendered right after its field is read, so one computed there, equal to it, is taken for it. A CMS's extension names its editor, `editor: `${import.meta.dir}/editor.kay``: an island every page renders last in edit mode, kept alive across pages and given `{ entries }`, each entry the page read. The pages that extension's own `routes` serve render none: its screens and the `_error` or `_404` page one fails with or a guard refuses with, its own or the app's. An app page replacing one of its screens renders it, as another extension's pages do; a URL no page serves, such as `/admin/nope` under its prefix, renders none. `showDraft(entries)` from `kay/edit` shows the page with the entries the editor has not saved, keeping the editor's island alive, or resolves where they fail the schema or name an unknown component; outside edit mode, or when the page fails to render, it throws.

## A CMS editing the collections

A CMS running in the app's server reads the collections through `collections()` and `entries(name)` from `kay/content`: each collection's schema as JSON Schema, its folder in the repository and its draft field, and each entry as its file or loader holds it, drafts included, with the page showing it. `entrySource(name, slug, data)` gives a folder entry's file as the editor wrote it, in the format it was read in, for the CMS to commit: kay writes no file. `entryFile(name, slug)` gives the file of an entry the CMS deletes, `{ file: { path, absolute, repoPath } }`, or `{ issues }` for a slug naming none. `saveEntry` and `removeEntry` hand a loaded entry to the loader's `save` and `remove`; each checks the entry against the collection first, and resolves `{ issues }` where it fails, a slug naming another file or no entry included. With `create: true`, both refuse an entry the collection already holds, and `saveEntry` tells the loader's `save`, which throws for one another process created since. A loader's `save` or `remove` never calls `saveEntry` or `removeEntry` for its own collection, which would wait for it and deadlock. A CMS edits entries whose data is an object of fields: both refuse a list or a plain value; `entrySource` checks as it is called, so the CMS commits the new file exclusively, failing if its path exists. A collection whose loader throws is listed with its `problem`, and an entry whose file does not parse with its own, for the CMS to write over. Their schemas and entries are typed as an island's props take them, `JsonSchema` and `DataValue`, so a page hands them to the CMS's island as they come. They give drafts and files to whoever calls them, so the CMS serves them behind a guard or `editRequested(request)`. `reference('authors')`, `imageField()`, `fileField()` and `markdownField()` mark the string fields it edits apart, and `draft: 'draft'` names a boolean field holding entries back, which the CMS publishes by writing false.

<ReadMore href="/llms/content">Syntax highlighting, `renderMarkdown`, the caches, atom feeds and the loader options are in the full content reference.</ReadMore>
