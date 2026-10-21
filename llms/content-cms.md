# Loaded collections, preview mode and the CMS editor

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
- An entry the schema refuses, one with no slug or with another entry's, or a load giving anything but an array, fails the read with every problem named, and the next read loads again.
- `load` gets `preview: true` for a visitor in preview mode and in development (`kay dev`, or the server's `dev` option), for a CMS that serves drafts apart.
- `save(entry)` and `remove(entry)` beside `load` write an entry back to the CMS, `{ slug, locale?, data, body?, create? }` and `{ slug, locale? }`, which `saveEntry` and `removeEntry` from `kay/content` call (see [A CMS editing the collections](#a-cms-editing-the-collections)).
- `create: true` comes with an entry the CMS creates: `save` throws when the entry exists, as a `save` that ignores it overwrites an entry another process created since, unnoticed.
- `save` and `remove` never call `saveEntry` or `removeEntry` for their own collection: that call waits for them to finish, so it deadlocks.
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

#### Edit mode

- Edit mode is preview mode for a CMS editing content on the page: `enterPreview(ctx, { edit: true })` from the CMS's guarded route or `previewUrl(path, { edit: true })` enter it, signed apart so no preview link or cookie becomes one, and `exitPreview` leaves both.
- Everything preview mode does holds, and `editing()` from `kay` is true while the server renders for such a visitor; `editRequested(request)` from `kay/server` tells the same of any request, for the CMS's own API modules and guards. `editedEntry(request, collection, slug)` from `kay/server` tells whether a page rendered in edit mode for the request's cookie read that entry, its collection named as the content config exports it, so a CMS's API serves an edit cookie, tied to no user, only those entries and not a customer or order collection. It is kept in memory per server until the cookie expires, so it is false on another server or after a restart until the page is loaded again.
- In edit mode the page marks what each entry's fields render, with nothing to declare: an element a field's text or number fills whole takes `data-kay-field="<collection>:<slug>[@locale]:<path>"`, the collection named as the content config exports it and the path dotted with indexes (`tags.0`); an attribute a field gives takes `data-kay-field-<name>`; text mixed with other text sits between `<!--kay-field ...-->` and `<!--/kay-field-->`; the element a `for` over a field's array fills takes `data-kay-list`; the element `Content` fills takes `data-kay-body="<collection>:<slug>[@locale]"`, else `<!--kay-body ...-->` comments.
- Islands, the static slots passed to them and the deferred parts of a streamed page stay unmarked, and outside edit mode the markup is unchanged.
- A field is marked wherever the data is read, in the page's fence or in a component, a loop or a snippet the entry's data was handed down to, whole (`Crew({...data})`) or by field (`Echo(text={entry.data.title})`), whatever the fence itself read; a frozen object's fields stay unmarked.
- A field is told apart by its value: a text is marked when it equals one a field gave and that is not rendered yet, the first read when several fields give the same text read together, else the latest one, and the earlier reads of that text are forgotten, so a field read only in a condition marks no later equal text; a number when it equals one read since a number no field gave was rendered, a literal text between two numbers of one child not counting, so a number is marked though a sibling field is read after it; each part of a mixed child (`{age} ans`) is marked on its own.
- A transformed value (`toUpperCase()`, a formatted date, a joined list) goes unmarked and a blank text is never marked.
- A text read but never rendered, such as `status` in `if status === 'draft'`, marks the next equal text rendered, a literal `"draft"` or another field holding it, as that field; a number computed equal to one just read is marked as it.
- A collection the content config does not export is named by its folder or loader name.

#### The editor

- A CMS's extension gives its editor as `editor: `${import.meta.dir}/editor.kay``, absolute or relative to the project root: an island every page renders at the end of its body in edit mode alone, kept alive across navigations and drafts (`persist`), and given `{ entries }`, typed `EditorProps` from `kay/edit`: each entry the page read, `{ collection, slug, locale? }`, its head and attributes included, those of the next page once the swap shows it. They come in the order the page shows each one's first marked field, not the order the reads resolved in, so a draft render keeps every form in place; an entry showing no marked field, one whose field a draft emptied say, comes after the others, by name.
- An entry read only in a deferred part of a streamed page is missing.
- The pages that extension's own `routes` serve render no editor: its screens and the `_error` or `_404` page one fails with or a guard refuses with, its own or the app's.
- An app page replacing one of its screens renders it, as another extension's pages do; a URL no page serves, `/nope` or `/admin/nope` under its prefix alike, renders none, as kay answers it outside preview mode, its `_404` showing no draft either.
- The editor needs a script the browser runs, and one extension at most gives one.
- The app's `kay check` reports the editor's errors, and those of what it imports, as its own when the extension is linked rather than installed, as a library's fixture app lists it.
- `showDraft(entries)` from `kay/edit`, called from the editor's island, shows the page with entries the editor has not saved in place of theirs, through the page swap, keeping scroll, focus and every island whose props did not change.
- Each entry is `{ collection, slug, locale?, data, body? }`, `collection` the config's export name and `body` Markdown.
- It resolves `{}` once shown, or `{ issues: [{ collection, slug, locale?, path, message }] }` showing nothing when the data fails the schema, `path` dotted (`tags.0`), `''` with `body: true` for a body that does not compile or uses a component the collection does not name, `''` with `key: 'locale'` for a locale missing from an entry of a localized collection, given to another's or not served by the site, `key: 'slug'` for a slug naming another folder, and a plain `''` for the data as a whole.
- A newer call cancels an older one, and going to another page cancels it too; either resolves `{}`.
- It throws outside edit mode (403), on a body over `bodyLimit` (413) and when the page fails to render (500).

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
- `reference`, `imageField`, `fileField`, `markdownField` and `customField` from `kay/content` give fields a CMS edits apart, `reference('authors')` say, reported in the schema as `x-kay: { kind, collection? }`: the slug of another collection's entry, the path the site serves an image or a file at (an upload's `files.url(key)` or a public file's), Markdown. `customField(kind, schema)` wraps any schema, not only a string, in a kind of the app's own, `customField('color', s.String({ pattern: '^#[0-9a-f]{6}$' }))`, which kayjs-cms edits with `src/cms/fields/<kind>.kay` ([kayjs-cms](../packages/cms/llms.txt)); the schema alone validates a save, and a built-in kind's name (`text`, `image`...) is refused.
- `await entries(name, { locale?, slug?, offset?, limit? })` from `kay/content` lists the entries as their source holds them, drafts included, those of one locale, of one slug, or a stretch of them in their order (a folder's files sorted, a loader's as it gives them) when asked, a folder reading no other file, a loader giving every entry and the filter applied after unless it has `get` (`collections()` and `collectionInfo()` from `kay/content` run a loader too, for its body and count, unless it has `count`; reads at the same moment share one run of `load`): `{ slug, locale?, path?, data, body?, draft, problem? }`.
- `data` is an object of fields typed by `DataValue` from `kay/content` (data holding a list or a plain value comes with no `data` and its `problem`).
- A folder entry's file is as written with its `path` relative to the repository (a file that does not parse comes with no `data` and its `problem`, a Markdown one with its `body` when the frontmatter alone fails; a folder missing, as beside a build alone, throws).
- A loaded entry is as `load({ preview: true })` gives it, loaded afresh on each call as preview mode loads it.
- A locale asked of a collection that is not localized throws.
- `draft` says whether the collection's `draft` holds it back.
- `url`, under the base, is the page of the route whose `page.prerender` is the collection, in the entry's locale, a whole URL on another locale's domain, or what the collection's `url: entry => string` option gives, called with the data as the schema decodes it: an entry the schema refuses takes the route's page.
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
- `await removeEntry(name, slug, locale?)` from `kay/content` calls its `remove` for an entry the loader gives, resolving `{}`, or `{ issues }` for a slug or locale naming none.
- A loaded slug may hold any part but `.` and `..` on either slash, `/about` say.
- Both throw for a folder collection or a loader without the method; a collection's saves and removes run in the process one at a time, in the order they are called, two of one entry keeping the later, and of two creates of one entry the second resolving the `slug` issue.
