# Recipes

Whole features built from what kay and its libraries ship, each with its files and the test that proves it. The topic files hold the rules; `examples/noticeboard` runs the first two beside mail and rooms.

## Common tasks

### List, create, edit and delete rows

A table in `src/db/`, the `db` over it, and the config of the `pg-orm` command importing the `db`; `kay/test/preload` makes each test file a copy of the migrated database from that config:

```ts
// src/db/todo.ts
import { defineTable } from '@kaynooo/pg-orm'

export const Todo = defineTable('todo', f => ({
  id: f.serial().primaryKey(),
  title: f.varchar(120),
  done: f.boolean().default(false),
}))
```

```ts
// src/env.ts
import { defineEnv, s } from 'kay/server'

export const env = defineEnv(s.Object({ DATABASE_URL: s.String() }))
```

```ts
// src/db/index.ts
import { Database } from '@kaynooo/pg-orm'
import { env } from '../env'
import { Todo } from './todo'

export const tables = [Todo]
export const db = new Database({ url: env.DATABASE_URL, tables })
```

```ts
// pg-orm.config.ts
import { defineConfig } from '@kaynooo/pg-orm'
import { db } from './src/db'

export default defineConfig({ db, migrationsDir: 'migrations' })
```

`bunx pg-orm generate` writes the migration and `bunx pg-orm apply` runs it. The page lists the rows and exports the create and delete actions, which render the page again with the new list, `src/routes/todos.kay`:

```kay
--- server
import { s } from 'kay'
import { db } from '../db'
import { Todo } from '../db/todo'

export const create = action(s.Object({
  title: s.String({ pattern: '\\S', maxLength: 120, error: 'Write a title' }),
}), async ({ title }) => {
  await db.repo(Todo).write.insertOne({ title: title.trim() })
})

export const remove = action(s.Object({ id: s.Integer() }), async ({ id }) => {
  await db.repo(Todo).write.deleteOne({ id })
})

const todos = await db.repo(Todo).read.findMany(q => q.orderBy('id', 'desc'))
---
head
  title Todos
h1 Todos
form(action={create})
  input(field="title")
  error title
  button Add
ul
  for todo of todos key={todo.id}
    li
      a(href={`/todos/${todo.id}`}) {todo.title}
      form(action={remove.with({ id: todo.id })})
        button Delete
```

A page per row edits it, `src/routes/todos/[id=integer].kay`. A missing row is a 404 and a saved edit goes back to the list:

```kay
--- server
import { s } from 'kay'
import { db } from '../../db'
import { Todo } from '../../db/todo'

export const save = action(s.Object({
  id: s.Integer(),
  title: s.String({ pattern: '\\S', maxLength: 120, error: 'Write a title' }),
  done: s.Boolean(),
}), async ({ id, title, done }, ctx) => {
  await db.repo(Todo).write.updateOne({ title: title.trim(), done }, { id })

  return ctx.redirect('/todos')
})

const todo = await db.repo(Todo).read.findById(Number(ctx.params.id)) ?? ctx.notFound()
---
head
  title {todo.title}
form(action={save.with({ id: todo.id })})
  input(field="title" value={todo.title})
  error title
  label
    input(field="done" type="checkbox" checked={todo.done})
    | Done
  button Save
```

The test calls the actions as a form posts them and reads the pages back, `tests/todos.test.ts`:

```ts
import { expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { create, remove } from '../src/routes/todos.kay'
import { save } from '../src/routes/todos/[id=integer].kay'

const site = await testSite()

it('creates, edits and deletes a todo', async () => {
  await site.call(create, { title: 'Water the plants' })
  expect((await site.visit('/todos')).find('li a').map(link => link.text)).toEqual(['Water the plants'])

  await expect(site.call(save, { id: 1, title: 'Water the ferns', done: true })).rejects.toMatchObject({ location: '/todos' })
  expect((await site.visit('/todos/1')).find('input')[0]?.attributes.value).toBe('Water the ferns')

  await site.call(remove, { id: 1 })
  expect((await site.visit('/todos')).find('li')).toHaveLength(0)
})
```

See [Actions](actions.md) and [Test databases and setup](testing-setup.md).

### Put a dashboard behind sign-in, with roles

`createAuth` declares the roles, an admin meeting what an editor does, and `pages: true` serves the sign-in, register and account pages, `src/auth.ts`:

```ts
import { createAuth } from '@kaynooo/kayjs-auth'
import { pgStore } from '@kaynooo/kayjs-auth/pg'
import { db } from './db'
import { sessions } from './session'

export const auth = createAuth({
  sessions,
  store: pgStore(db),
  name: 'Dashboard',
  pages: true,
  roles: { admin: ['editor'], editor: [] },
  defaultRoles: ['editor'],
})
```

`tables` in `src/db/index.ts` gains `...authTables` from `@kaynooo/kayjs-auth/pg`, so the migration holds kayjs-auth's tables beside the app's, and `src/session.ts` exports `sessions = session<AuthSessionData>()` from `kay/server`. A `_guard.ts` closes a folder to signed-in users, and a deeper one narrows a folder to admins:

```ts
// src/routes/dashboard/_guard.ts
import { auth } from '../../auth'

export default auth.guard()
```

```ts
// src/routes/dashboard/users/_guard.ts
import { auth } from '../../../auth'

export default auth.guard({ require: 'admin' })
```

An anonymous visitor goes to the sign-in page and comes back to where they were, and a signed-in user without the role is refused with a 403. The dashboard greets the user and shows the admin link to admins only, `src/routes/dashboard/index.kay`:

```kay
--- server
import { auth } from '../../auth'

const user = await ctx.locals.auth.requireUser()
const admin = auth.isGranted('admin', user)
---
head
  title Dashboard
h1 Hello {user.username ?? user.email}
if admin
  a(href="/dashboard/users") Members
```

The admin page needs nothing of its own, `src/routes/dashboard/users/index.kay`:

```kay
head
  title Members
h1 Members
```

An action is covered by the guards of its folder; one that lives elsewhere checks its role itself:

```ts
// src/routes/dashboard/users/index.kay, in its server fence
import { auth } from '../../../auth'

export const ban = action(s.Object({ id: s.String() }), async ({ id }, ctx) => {
  const user = await ctx.locals.auth.requireUser()

  if (!auth.isGranted('admin', user))
    return ctx.fail(403, { error: 'Admins only' })

  await db.repo(Notice).write.deleteMany({ author_id: id })
})
```

The test signs in as a member of each role without going through the forms, `tests/dashboard.test.ts`:

```ts
import { expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { auth } from '../src/auth'

const site = await testSite()

it('keeps the dashboard to members and the member list to admins', async () => {
  expect((await site.fetch('/dashboard')).status).toBe(302)

  await auth.signInAs(site, { email: 'ada@example.com', roles: ['editor'] })
  expect((await site.visit('/dashboard')).status).toBe(200)
  expect((await site.visit('/dashboard/users')).status).toBe(403)

  await auth.signInAs(site, { email: 'grace@example.com', roles: ['admin'] })
  expect((await site.visit('/dashboard/users')).status).toBe(200)
})
```

See [Locals, sessions and guards](server.md#locals) and [kayjs-auth](packages/auth/llms.txt).

### Publish a blog with tags, an RSS feed and a sitemap

One collection holds the posts, with the feed on it, `src/content.config.ts`. The `site` of kay.config.ts is what the feed and the sitemap build their absolute links from:

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
  feed: {
    path: '/blog/rss.xml',
    title: 'Blog',
    item: post => ({ title: post.data.title, path: `/blog/${post.slug}`, date: post.data.date }),
  },
})
```

A post is a Markdown file of that folder, `src/content/posts/hello.md`:

```md
---
title: Hello
date: 2026-01-01
tags: [news]
---

The first post.
```

The list is paginated, and `prerender` takes the paginated collection, `src/routes/blog/[[page=integer]].kay`:

```kay
--- server
import { paginate } from 'kay/content'
import { posts } from '../../content.config'

const blog = paginate(posts, 10)

export const page = { prerender: blog }

const list = await blog.page(ctx.params.page) ?? ctx.notFound()
---
head
  title Blog
  link(rel="alternate" type="application/rss+xml" href="/blog/rss.xml")
h1 Blog
for post of list.items key={post.slug}
  article
    h2
      a(href={`/blog/${post.slug}`}) {post.data.title}
    p
      for tag of post.data.tags
        a(href={`/blog/tags/${tag}`}) {tag}
if list.prev
  a(href={list.prev}) Newer
if list.next
  a(href={list.next}) Older
```

A post is its own page, listed in the sitemap by the same collection, `src/routes/blog/[slug].kay`:

```kay
--- server
import { posts } from '../../content.config'

export const page = { prerender: posts, sitemap: posts }

const post = await posts.get(ctx.params.slug) ?? ctx.notFound()
const { Content } = post
---
head
  title {post.data.title}
h1 {post.data.title}
article
  Content
```

A page per tag in use lists its posts, `src/routes/blog/tags/[tag].kay`:

```kay
--- server
import { posts } from '../../../content.config'

export const page = {
  prerender: async () => [...new Set((await posts.all()).flatMap(post => post.data.tags))].map(tag => ({ tag })),
}

const { tag } = ctx.params
const tagged = (await posts.all()).filter(post => post.data.tags.includes(tag))
---
head
  title Posts tagged {tag}
h1 {tag}
for post of tagged key={post.slug}
  a(href={`/blog/${post.slug}`}) {post.data.title}
```

The test reads the pages, the feed and the sitemap from the site, `tests/blog.test.ts`:

```ts
import { expect, it } from 'bun:test'
import { testSite } from 'kay/test'

const site = await testSite()

it('serves the posts, their tag pages, the feed and the sitemap', async () => {
  expect((await site.visit('/blog')).find('h2 a').map(link => link.text)).toEqual(['Hello'])
  expect((await site.visit('/blog/tags/news')).find('a').map(link => link.text)).toEqual(['Hello'])
  expect(await (await site.fetch('/blog/rss.xml')).text()).toContain('<title>Hello</title>')
  expect(await (await site.fetch('/sitemap.xml')).text()).toContain('/blog/hello')
})
```

See [Content collections](content.md) and [Sitemap, favicon, offline, search and fonts](sitemap-search-fonts.md).
