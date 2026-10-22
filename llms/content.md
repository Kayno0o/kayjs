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
  route: '/blog/:slug',
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
      a(href={post.url}) {post.data.title}
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

### Give each entry its page's path

`route: '/blog/:slug'` on the collection gives each entry a typed `url`, the path of its page, so links and feeds write no path; `'/docs/*slug'` keeps the folders of a slug:

```ts
export const posts = collection('content/posts', {
  schema: s.Object({ title: s.String(), date: s.Date() }),
  route: '/blog/:slug',
  feed: { path: '/blog/rss.xml', title: 'Blog', item: post => ({ title: post.data.title, date: post.data.date }) },
})
```

- `a(href={post.url}) ...` links it; `url` is the path as `route()` writes it, so kay puts the base and the page's locale on it as on any link.
- A localized entry's `url` has its own slug, so `(await posts.translation(post, 'fr'))?.url` is the page of its translation, on a page that read the entry with `get()`, `alternate('fr')` gives it too. A dotted slug, `v1.2`, is a page, not a file; so is an entry's `release.html` (re-read on `invalidate()`); links ending in `.png` are files. A slug the route cannot write (`..`) leaves its entry out, logged. The CMS reads the route before `url`.
- A feed item with no `path` links the entry's `url`, absolute on the site, in the locale's feed under its prefix, as `trailingSlash` writes a page's address.
- The route has one param, the slug: `:slug`, or `*slug` for slugs with folders, and `collection()` refuses any other.
- `kay check` reports a route no page's pattern matches (`src/routes/blog/[slug].kay`, whatever its param is named); a page listing the entries in `prerender: posts` while another page serves the route is reported too.
- A collection with no `route` has no `url`.

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
  a(href={post.url}) {post.data.title}
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

- `all()` gives every entry in the collection's `sort` order, by its `order` field without one, by slug without either; filter and sort it like any array.
- `get(slug)` gives one entry or `undefined`.
- An entry has `slug`, its path in the folder without the extension (`guides/intro`; an `index` file takes its folder's), `data`, `headings` (`{ depth, id, text }` in order, for a table of contents), `Content`, the component rendering its body, `words`, `readingTime` and `file`.
- `words` counts the words of the rendered text, code blocks and Markdown inside a component's tags included, and a component's own output left out, since it only exists once a page renders; `readingTime` is the minutes at `markdown.readingSpeed` words a minute (230 by default), at least 1 for a body with words and 0 for an entry with none: `post.readingTime` gives `3`.
- A data file's `headings` is empty, its `words` and `readingTime` are 0, and its `Content` renders nothing.
- A `slug` in an entry's frontmatter, or in a data file, is its slug instead of its path, so a translated post gets its own: a path of non-empty parts, none `.` or `..`, with no backslash, control character, `?` or `#`, else the entry fails the collection at that line. In a localized collection it follows the locale's folder, `fr/hello.md` with `slug: bonjour` is `bonjour` in `fr`, and `translations` pairs entries by equal slug unless they set a `translationKey` field in their frontmatter, a key of your choosing that `en/hello-world.md` and `fr/bonjour-le-monde.md` both give, `translationKey: hello`; two entries of one locale cannot share a key (a slug counts as one), nor can a key be anything but a string, else the collection fails at that file. A schema that closes its fields lists `slug` and `translationKey`; the file keeps its path in `file`.
- Two files giving one slug, `guides.md` and `guides/index.md`, fail the collection.
- Entries are the site's own content, trusted: their HTML, links and what a highlighter returns go out as written, unsanitised.

#### Drafts

- An entry `draft` returns true for shows in development (`kay dev`, or the server's `dev` option, which wins over `NODE_ENV`) and to a visitor in preview mode only.
- Everywhere else a draft is left out of `all()`, `get()`, prerendering, the sitemap and the feed.
- `draft: 'draft'`, a boolean field's name, holds back the entries where it is true, which a CMS then reads and publishes by writing false.
- `publishAt: 'publishAt'`, an `s.Date()` field's name, holds an entry back until that time, as a draft is, and shows it by itself then, in `all()`, `get()`, `translation()`, the pages prerendered from it, the sitemap and the feed; `kay dev` and preview mode show it at once. An entry with no date, or a date in the past, is published: a server down at that time shows it from its next boot, and one whose loader fails then logs once and reads the dates again every minute, its start waiting for the first read one second at most. A draft stays one whatever its date, so `draft: 'draft'` and `publishAt` together hold an entry until it is neither.
- `unpublishAt: 'endsAt'`, another `s.Date()` field's name, takes an entry down from that time on, as a draft is, in the same places and by itself: the pages that read the collection render again, the page of an ended entry answers 410 Gone when its code calls `ctx.notFound()` after `get()` finds nothing (a draft or an entry not yet published stays 404), or what its code does otherwise (`ctx.redirect(...)`), and a redirect from the path, in `redirects` or added while the site runs, wins over the 410 (any `ctx.notFound()` of the same render answers 410 once `get()` found an ended entry, and an app's own 410 can be redirected the same way), the visit being listed on the missing pages screen, and a server down then catches up as it starts. No date never ends; `kay dev` and preview mode keep showing it; with `publishAt` an entry has a window.
- The date is read as `s.Date()` reads it, never in the server's time zone: `2026-10-20` is 00:00 UTC, and `2026-10-20T08:00:00+02:00` is that instant; write the offset for an hour in your own zone, as an hour with neither `Z` nor an offset is refused. A field that is not an `s.Date()` is a type error in `kay check` and fails the boot.
- A server refreshes the prerendered pages that read the collection when a date passes, in each process on its own clock, so replicas sharing a store each do it and the app writes no cron, job or webhook; `live: true` pages follow too, and the sitemap is built afresh. The entry's own page, which the build did not list, renders per request until the next build. A static export (`kay build --static`) cannot change by itself: it leaves the entry out until the next build, so rebuild on a schedule in CI.
- `order: 'position'`, a number field's name, orders the entries by it, ascending, those without a number last, unless `sort` says otherwise; kayjs-cms then lists them so and moves an entry up or down by writing the field, so the editor never types the numbers.
- `live: true` has every open page that read the collection (`all()`, `get()`, `translation()`) in its server fence or a layout's show it afresh in each tab once `posts.invalidate()` drops it, so a kayjs-cms save or removal shows in the other open tabs; it is the collection's side of `cached(..., { live: true })` ([Following cached values](live-values.md#following-cached-values)), with the same cost, and read it directly: a read inside a `cached` load follows only when that `cached` has `live: true`; a page reading it is rendered per request and a static export of it fails with `export-server-render`.
- `single: true` makes the collection one entry, such as a home page's texts: kayjs-cms opens its form straight from the content list, titled with the collection's `title`, with no list row, slug field, New entry or Delete; the entry is written as `index`, and `await home.one()` gives its data (`one(fallback)` gives `fallback` while none is written; with a `seed`, or a fallback, it is typed as the data, else it may be undefined), else the `seed: { ... }` option's data, which the form opens filled with and the first save writes; a page rendering the seed in edit mode marks its fields as the entry's own, so a click opens that form before any save. Not with `localized`; a `seed` needs `single`; keep one entry, the admin shows the first.
- `title: 'Produits'` is what a CMS titles the collection with, instead of its export's name humanized (`produits` gives `Produits`, `blogPosts` gives `Blog posts`); the name still keeps the URLs, the markers and the upload folder.
- `description: 'What the team needs to know'` is a line a CMS shows an editor under the collection's title, on its list and its entries.

Markdown files, components in Markdown, pages from a collection, pagination, rendering Markdown, feeds, localized collections and caching are in [Content collections: Markdown to caching](content-markdown-to-caching.md).
