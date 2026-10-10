---
title: Content collections
order: 3
description: Read Markdown and data files against a schema, and render a page per entry.
---

A collection is a folder of Markdown, JSON or YAML files, each checked against a schema. Declare them in `src/content.config.ts`, each folder relative to that file, so `content/posts` is `src/content/posts`:

```ts
import { t } from 'kay'
import { collection } from 'kay/content'

export const posts = collection('content/posts', {
  schema: t.Object({
    title: t.String(),
    date: t.Date(),
    tags: t.Array(t.String(), { default: [] }),
    draft: t.Optional(t.Boolean()),
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

An entry has `slug`, `data`, `headings` (for a table of contents) and `Content`, the component rendering its body. Entries marked as drafts show in `kay dev` only.

## A page per entry

`src/routes/blog/[slug].kay` reads one entry and prerenders a page for each of them:

```kay
--- server
import { posts } from '../../content.config'

export const prerender = posts

const post = await posts.get(ctx.params.slug) ?? ctx.notFound()
const { Content } = post
---
h1 {post.data.title}
article
  Content
```

A slug with a slash, like `guides/intro`, needs a catch-all page, `[...slug].kay`.

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

An interactive component renders as an island. A component the collection does not name fails `kay check` and the build.

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
  schema: t.Object({ title: t.String() }),
})
```

`news.invalidate()` refreshes it, typically from a webhook in an API route.

## Preview mode

Setting `preview: { secret }` in `kay.config.ts` lets an editor see drafts on the live site through a signed link, see [the full reference](/llms/content#preview-mode).

<ReadMore href="/llms/content">Syntax highlighting, `renderMarkdown`, the caches, atom feeds and the loader options are in the full content reference.</ReadMore>
