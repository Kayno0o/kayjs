---
title: content.config.ts
order: 18
description: The content collections, each a folder of files checked against a schema.
path: src/content.config.ts
---

`src/content.config.ts` declares the content collections, each folder relative to it, so `content/posts` is [`src/content/posts`](/structure/content):

```ts
import { s } from 'kay'
import { collection } from 'kay/content'

export const posts = collection('content/posts', {
  schema: s.Object({
    title: s.String(),
    date: s.Date(),
    draft: s.Optional(s.Boolean()),
  }),
  draft: post => post.data.draft === true,
  sort: (a, b) => b.data.date.getTime() - a.data.date.getTime(),
})
```

Pages import a collection from it and read its entries, typed from the schema, with `all()` and `get(slug)`:

```kay
--- server
import { posts } from '../../content.config'

const entries = await posts.all()
---
ul
  for post of entries
    li: a(href={`/blog/${post.slug}`}) {post.data.title}
```

<ReadMore href="/guides/content">Content collections, a page per entry, feeds and CMS sources.</ReadMore>
