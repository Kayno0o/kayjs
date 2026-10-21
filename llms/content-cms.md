# Loaded collections and preview mode

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
  preview: { secret: process.env.PREVIEW_SECRET! },
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

- `load` gives an array of `{ slug, data, body }` or `{ slug, data, html }`: `data` is read against the schema, defaults filled in and dates decoded; `body` is Markdown, compiled as a file's body, headings listed, code highlighted and the collection's components usable; `html` is rendered as it is, trusted as a file entry's is.
- `count({ preview })` gives how many entries `load` would, `body: false` says they hold `html` rather than a Markdown `body` (true when left out), and `get(place, { preview })` gives the one entry at a place, its slug with the locale before it in a localized collection, `fr/launch`, or undefined: a CMS (`collections()`, `collectionInfo()` and `entries(name, { slug })` from `kay/content`) asks them in place of running `load` for every entry.
- An entry's `file` is the collection's name and its slug, `news/launch`.
- One with no slug or with another entry's, or a load giving anything but an array, fails the read with every problem named, and the next read loads again.
- An entry the schema refuses, or that sits outside a locale folder in a localized collection, is left out of `all()`, `get()` and `translation()` and logged as a warning naming each problem at its full path (`packs.0.price: ...`), so one stale row never hides the others; the admin still lists it (`entries()` gives its data, migrated when the collection has `migrations`), opens it with the schema's issues and saves it fixed, and the pages show it from that save. A folder's entry the schema refuses still fails `kay check`, `kay build` and the read, since its file is fixed in the repository.
- `migrations: [...]` on the collection's options carries stored entries over after a schema change, each step taking an entry's data in its old shape and giving the new one: `renameField(from, to)`, `setField(name, value)` and `convertField(name, convert)` from `kay/content` build the common steps (`setField` fills a field only when it is missing, from a value or a `(data) => value`, `convertField` changes it only when present, `convert(value, data)`), any `(data) => data` is one. Steps run in order, on a copy, only on an entry the schema refuses (defaults filled first), stopping once it accepts it, so write a step to leave data already in the new shape alone; an entry no step brings to the schema stays refused, and a step that throws is logged and leaves its entry as it was. A folder collection's entries migrate as they are read and their files stay; `kay migrate content [dir] [--format text|json] [--quiet]` rewrites the files of every folder collection with `migrations` whose entries a step carried over, keeping each file's format (JSON indentation, YAML, a Markdown body byte for byte, a `# draft` mark), a file that cannot be read listed and the exit code 1. A folder entry the schema refuses with no `migrations` declared is reported with a line naming `migrations` and `kay migrate content`. `unique()` reads a field of an `Intersect` too.
- A loaded entry that migrated is handed to the loader's `save` once as `{ slug, locale?, data, body? }` (the body as the loader gave it), so the next read finds it in the new shape; a `save` that throws is logged and the entry stays migrated for that read, tried again at the next. A loader without `save` is migrated at each load. A folder's entry is migrated as read, by the build too, and its file kept until a CMS saves it. The admin's `entries()` gives the migrated data, so a save writes the new shape.
- `load` gets `preview: true` for a visitor in preview mode and in development (`kay dev`, or the server's `dev` option), for a CMS that serves drafts apart.
- `save(entry)` and `remove(entry)` beside `load` write an entry back to the CMS, `{ slug, locale?, data, body?, create? }` and `{ slug, locale? }` (`save`'s `data` is typed from the collection's `schema`, which kay has checked it against: each missing default is filled in and a date is its ISO text, as the JSON a CMS sends holds it, so it needs no cast), which `saveEntry` and `removeEntry` from `kay/content` call (see [A CMS editing the collections](#a-cms-editing-the-collections)).
- `create: true` comes with an entry the CMS creates: `save` throws when the entry exists, as a `save` that ignores it overwrites an entry another process created since, unnoticed.
- `saveMany(entries)` is optional: it writes several entries a CMS saves together (a reorder swaps two), all or none, as `saveEntries(name, entries)` from `kay/content` hands them on after checking each; a loader without it gets them one `save` at a time. kayjs-cms ships SQLite and Postgres loaders with it ([loaders](../packages/cms/llms/loaders.md)).
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

Edit mode, which marks the page for a CMS's on-page editor, and the editor itself are in [Edit mode and the CMS editor](content-edit.md).

### A CMS editing the collections

A CMS running in the app's server, as a kay extension, reads and edits the collections the content config exports, through `kay/content`. These give drafts and files to whoever calls them, so the CMS serves them from routes only an editor reaches, behind a guard or `editRequested(request)`:

- `await collections()` from `kay/content` describes each, and `await collectionInfo(name)` one alone, reading no other, undefined for a name none is exported as: `{ name, title?, kind: 'folder' | 'loaded', schema, body?, components, localized, locales?, dir?, draftField?, orderField?, count?, problem? }`, `count` the number of entries, every locale's, a folder's files listed and never read, `problem` saying why a collection's entries fail to read, a loader throwing say, `body` then assumed, the others listed still. `collections({ counts: false })` and `collectionInfo(name, { counts: false })` leave out `body`, `count` and `problem`, so no loader runs and no folder is listed.
- `name` is the export name, the one the page's markers and `showDraft` use.
- `schema` is plain JSON Schema, a date a `date-time` string, typed `JsonSchema` from `kay/content`.
- `body: { kind: 'markdown' }` when entries hold a Markdown body (a folder holding Markdown, a loader giving `body` rather than `html`, or either with no entry yet).
- `components` names those a body may use.
- `locales`, for a localized collection, the locales the site serves.
- `dir`, a folder collection's, is relative to the repository holding the project, whose path on the server `repositoryRoot()` from `kay/content` gives, and absent for a folder outside it.
- The schemas and entries are typed as an island's props take them, so a CMS page hands its editor island `collections()` and `entries()` from `kay/content` as they come, with no cast.
- `untranslated(schema)` from `kay/content` marks a field (or an object or array of them) that `kay i18n translate` leaves as the default locale's value, such as a brand or a code, reported as `x-kay-translate: false`; it keeps the kind, so it wraps a `markdownField` or a plain `t.String()` alike.
- `fieldInput(schema, options)` from `kay/content` tells a CMS how to enter a field (reported as `x-kay-input`): a placeholder, a prefix or suffix, rows, labels, lines, a list item's title or a `when` on a sibling; a collection's `description` is shown above its entries ([kayjs-cms](../packages/cms/llms/fields.md)).
- `unique(schema)` from `kay/content` marks a field (reported as `x-kay-unique: true`) whose value no other entry of the collection, of the same locale in a localized one, may hold: `saveEntry`, a folder entry's source and a draft's check refuse a repeat with the issue `is already the code of a` at the field's path, read against every entry, drafts included. A save of a loaded entry is checked again in its turn; a folder's files cannot be, so two commits of one value pass. Nothing checks entries already stored.
- `colorField()`, `moneyField({ currency })`, `tagsField()`, `linkField()`, `geoField()` and `iconField(iconifySet)` from `kay/content` are ready-made kinds with a control in kayjs-cms ([kayjs-cms](../packages/cms/llms/fields.md#ready-made-kinds)).
- `reference`, `imageField`, `fileField`, `markdownField` and `customField` from `kay/content` give fields a CMS edits apart, `reference('authors')` say, reported in the schema as `x-kay: { kind, collection? }`: the slug of another collection's entry, the path the site serves an image or a file at (an upload's `files.url(key)` or a public file's), Markdown. `imageField({ accept, maxSize, minWidth, minHeight, alt, width, height })` and `fileField({ accept, maxSize })` also take what the editor asks of a file and, for an image, the keys of the fields beside it that hold its alt text and size (reported in `x-kay`; `FieldHint` from `kay/content` types it), which kayjs-cms fills in and leaves out of its form ([kayjs-cms](../packages/cms/llms/uploads.md)). `customField(kind, schema)` wraps any schema, not only a string, in a kind of the app's own, `customField('color', s.String({ pattern: '^#[0-9a-f]{6}$' }))`, which kayjs-cms edits with `src/cms/fields/<kind>.kay` ([kayjs-cms](../packages/cms/llms.txt)); the schema alone validates a save, and a built-in kind's name (`text`, `image`...) is refused.
- `await entries(name, { locale?, slug?, offset?, limit? })` from `kay/content` lists the entries as their source holds them, drafts included, those of one locale, of one slug, or a stretch of them in their order (a folder's files sorted, a loader's as it gives them) when asked, a folder reading no other file, a loader giving every entry and the filter applied after unless it has `get` (`collections()` and `collectionInfo()` from `kay/content` run a loader too, for its body and count, unless it has `count`; reads at the same moment share one run of `load`): `{ slug, locale?, path?, data, body?, draft, problem? }`.
- `data` is an object of fields typed by `DataValue` from `kay/content` (data holding a list or a plain value comes with no `data` and its `problem`).
- A folder entry's file is as written with its `path` relative to the repository (a file that does not parse comes with no `data` and its `problem`, a Markdown one with its `body` when the frontmatter alone fails; a folder missing, as beside a build alone, throws).
- A loaded entry is as `load({ preview: true })` gives it, loaded afresh on each call as preview mode loads it.
- A locale asked of a collection that is not localized throws.
- `draft` says whether the collection's `draft` holds it back.
- `url`, under the base, is the page of the route whose `page.prerender` or `page.sitemap` is the collection, in the entry's locale, a whole URL on another locale's domain, or what the collection's `url: entry => string` option gives, called with the data as the schema decodes it: an entry the schema refuses takes the route's page. An entry of a collection no route lists (a section read by its slug, the site's settings) takes the first page without params that shows it, the shallowest first: kay renders those pages once in edit mode, the first time a CMS asks, and keeps what each read for five minutes (a page that fails to render is logged and tried again by the next screen); a page its guard refuses shows nothing, and an entry no page shows has no `url`.
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
- `await saveEntries(name, [{ slug, locale?, data, body? }])` from `kay/content` checks every entry as `saveEntry` does, then writes them with the loader's `saveMany`, resolving `{ issues }` for the first refused with nothing written.
- `await removeEntry(name, slug, locale?)` from `kay/content` calls its `remove` for an entry the loader gives, resolving `{}`, or `{ issues }` for a slug or locale naming none.
- `await translations(name)` from `kay/content` gives a localized collection's `Map` of translation key (the `translationKey` field, else the slug) to a `Map` of locale to the slug written there, without reading every entry per call: built once, then served until a save or remove through these functions, `invalidate()` or the loader's `ttl` drops it, a folder's until a file of it changes. Empty for a collection not localized.
- A loaded slug may hold any part but `.` and `..` on either slash, `/about` say.
- Both throw for a folder collection or a loader without the method; a collection's saves and removes run in the process one at a time, in the order they are called, two of one entry keeping the later, and of two creates of one entry the second resolving the `slug` issue.
