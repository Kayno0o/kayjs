# Loaded collections, with the first steps of preview mode

Preview mode in full, share links and the CMS editor: [Preview mode and CMS editing](content-preview.md).

## Common tasks

### Load entries from a headless CMS

A collection takes a `load` function in place of a folder, and a webhook refreshes it through an API route, `src/api/cms.ts`, one `news.invalidate()` for the entries and every prerendered page that read them:

```ts
import { api } from 'kay/server'
import { news } from '../content.config'

export default api().post('/', ({ headers, status }) => {
  if (headers['x-webhook-secret'] !== process.env.CMS_WEBHOOK_SECRET)
    return status(401)

  news.invalidate()

  return new Response(null, { status: 204 })
})
```

### Let an editor see drafts on the live site

`preview` in kay.config.ts (`false` for none) takes a secret, and `previewUrl` from `kay/server` gives a signed link to a page, valid an hour:

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  preview: {},
})
```

## Reference

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

- `load` gives an array of `{ slug, data, body }` or `{ slug, data, html }` (a slug with no part `.` or `..`, no backslash and no control character, else a content problem; an empty part, `?` and `#` are kept, a route encoding them or leaving the entry out): `data` is read against the schema, defaults filled in and dates decoded; `body` is Markdown, compiled as a file's body, headings listed, code highlighted and the collection's components usable; `html` is HTML. Both are sanitized as a user's Markdown is (formatted text, links, images and tables kept; scripts, handlers, styles, iframes, comments and `javascript:` links dropped; heading anchors, code languages, components and relative URLs kept, and a `rel="nofollow ugc"` only on a link written with an http(s) URL, since the site is not known when the body compiles; component props are the body's own, so a collection's components should not trust them), since a loader often reads content its author did not write. `trusted: true` in the collection's options keeps both as they are, raw HTML included, as a folder's files always are.
- `count({ preview })` gives how many entries `load` would, `body: false` says they hold `html` rather than a Markdown `body` (true when left out), and `get(place, { preview })` gives the one entry at a place, its slug with the locale before it in a localized collection, `fr/launch`, or undefined: a CMS (`collections()`, `collectionInfo()` and `entries(name, { slug })` from `kay/content`) asks them in place of running `load` for every entry.
- An entry's `file` is the collection's name and its slug, `news/launch`.
- One with no slug or with another entry's, or a load giving anything but an array, fails the read with every problem named, and the next read loads again.
- An entry the schema refuses, or that sits outside a locale folder in a localized collection, is left out of `all()`, `get()` and `translation()` and logged as a warning naming each problem at its full path (`packs.0.price: ...`), so one stale row never hides the others; the admin still lists it (`entries()` gives its data, migrated when the collection has `migrations`), opens it with the schema's issues and saves it fixed, and the pages show it from that save. A folder's entry the schema refuses still fails `kay check`, `kay build` and the read, since its file is fixed in the repository.
- `migrations: [...]` on the collection's options carries stored entries over after a schema change, each step taking an entry's data in its old shape and giving the new one: `renameField(from, to)`, `setField(name, value)` and `convertField(name, convert)` from `kay/content` build the common steps (`setField` fills a field only when it is missing, from a value or a `(data) => value`, `convertField` changes it only when present, `convert(value, data)`), any `(data) => data` is one. Steps run in order, on a copy, only on an entry the schema refuses (defaults filled first), stopping once it accepts it, so write a step to leave data already in the new shape alone; an entry no step brings to the schema stays refused, and a step that throws is logged and leaves its entry as it was. A folder collection's entries migrate as they are read and their files stay; `kay migrate content [dir] [--format text|json] [--quiet]` rewrites the files of every folder collection with `migrations` whose entries a step carried over, keeping each file's format (JSON indentation, YAML, a Markdown body byte for byte, a `# draft` mark), a file that cannot be read listed and the exit code 1. A folder entry the schema refuses with no `migrations` declared is reported with a line naming `migrations` and `kay migrate content`. `unique()` reads a field of an `Intersect` too.
- A loaded entry that migrated is handed to the loader's `save` once as `{ slug, locale?, data, body? }` (the body as the loader gave it), so the next read finds it in the new shape; a `save` that throws is logged and the entry stays migrated for that read, tried again at the next. A loader without `save` is migrated at each load. A folder's entry is migrated as read, by the build too, and its file kept until a CMS saves it. The admin's `entries()` gives the migrated data, so a save writes the new shape.
- `load` gets `preview: true` for a visitor in preview mode and in development (`kay dev`, or the server's `dev` option), for a CMS that serves drafts apart.
- `save(entry)` and `remove(entry)` beside `load` write an entry back to the CMS, `{ slug, locale?, data, body?, create? }` and `{ slug, locale? }` (`save`'s `data` is typed from the collection's `schema`, which kay has checked it against: each missing default is filled in and a date is its ISO text, as the JSON a CMS sends holds it, so it needs no cast), which `saveEntry` and `removeEntry` from `kay/content` call (see [A CMS editing the collections](content-preview.md#a-cms-editing-the-collections)).
- `create: true` comes with an entry the CMS creates: `save` throws when the entry exists, as a `save` that ignores it overwrites an entry another process created since, unnoticed.
- `saveMany(entries)` is optional: it writes several entries a CMS saves together (a reorder swaps two), all or none, as `saveEntries(name, entries)` from `kay/content` hands them on after checking each; a loader without it gets them one `save` at a time. An entry given `expect: { field, was }` is a compare-and-swap of one number field: the loader writes that field alone, leaving the rest as stored, and throws `ContentChangedError` from `kay/content` with nothing written when the stored entry is gone or holds another number there (`undefined` for none), which `saveEntries` answers as `{ changed: true }`; a loader ignoring `expect` writes the whole entry. kayjs-cms ships SQLite and Postgres loaders with it ([loaders](../packages/cms/llms/loaders.md)).
- `sibling(kind)` is optional: it gives a loader for a hidden collection of that kind in the same store (`'history'`, `'trash'`, `'activity'`), whose entries never show in this one, where kayjs-cms keeps an entry's revisions, its deleted entries and who did what ([History, the trash and the activity log](../packages/cms/llms/history.md)); a loader without it has none. kayjs-cms's SQLite and Postgres loaders have it, and `collectionLoader(name)` from `kay/content` gives the loader of a loaded collection.
- `save`, `saveMany` and `remove` never call `saveEntry`, `saveEntries` or `removeEntry` for their own collection: that call waits for them to finish, so it deadlocks.
- The entries are loaded on the first read and kept as `cached` keeps a value (see [Caching](rendering.md#caching)): concurrent first reads share one load; with `ttl`, a read past it gets them as they were and refreshes them in the background; without, they are kept until `invalidate()` or a restart.
- `store: sqliteCache(path)` keeps them across restarts and has `invalidate()` reach every process sharing it.
- `prerender`, `sitemap` and a feed take a loaded collection as a folder's: `kay build` loads it to prerender, so it needs the CMS to answer.
- `kay check` types it from the schema but never calls the loader, and `kay build` writes nothing of it for production, which reads it when the server runs.
- A CMS's webhook refreshes it through an API route, `news.invalidate()` also refreshing the prerendered pages that read it; the route refuses a request while the secret is unset, and compares it in constant time:

```ts
// src/api/cms.ts
import { createHash, timingSafeEqual } from 'node:crypto'
import { api } from 'kay/server'
import { news } from '../content.config'

const digest = (text: string) => createHash('sha256').update(text).digest()

export default api().post('/', ({ headers, status }) => {
  const secret = process.env.CMS_WEBHOOK_SECRET
  const sent = headers['x-webhook-secret']
  if (!secret || !sent || !timingSafeEqual(digest(sent), digest(secret)))
    return status(401)

  news.invalidate()

  return new Response(null, { status: 204 })
})
```

