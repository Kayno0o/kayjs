# Loaders and a live CMS

A site whose editors save on the running server keeps its entries in a database. kayjs-cms ships a loader for each of the two it supports, SQLite on `bun:sqlite` and Postgres on Bun's own `SQL`: no dependency to add, one table of JSON entries, no schema to write.

## Common tasks

### Keep entries in SQLite

A collection over `sqliteLoader` is edited by the screens and the on-page editor with nothing else declared, and `seed` fills it once:

```ts
// src/content.config.ts
import { s } from 'kay'
import { collection } from 'kay/content'
import { sqliteLoader } from '@kayjs/cms/sqlite'

export const posts = collection(sqliteLoader({
  name: 'posts',
  database: 'data/content.sqlite',
  seed: [{ slug: 'hello', data: { title: 'Hello', order: 1 }, body: 'First post.' }],
}), {
  schema: s.Object({ title: s.String(), order: s.Number() }),
  order: 'order',
})
```

### Keep entries in Postgres

`pgLoader` from `@kayjs/cms/pg` takes a `source`: a connection URL, a Bun `SQL` or a pg-orm `Database` (`source: db`):

```ts
import { pgLoader } from '@kayjs/cms/pg'

export const posts = collection(pgLoader({ name: 'posts', source: process.env.DATABASE_URL! }), {
  schema: s.Object({ title: s.String() }),
})
```

### Wiring a live CMS

1. `kay add cms`, and set `preview: {}` in `kay.config.ts` (edit mode is kay's preview mode, signed with a key from `KAY_SECRET`).
2. Declare each editable collection over a loader as above, `order`, `draft`, `publishAt` and `localized` working as on a folder.
3. Add `cms({ guard })` to `extensions`, the guard being who may edit, such as kayjs-auth's `auth.guard({ require: 'editor' })`. A loader needs no `files` saver: that is for folder entries.
4. Put the database where a deploy keeps it: a volume for the SQLite file, the app's `DATABASE_URL` for Postgres.
5. Read the collections in pages as usual (`all()`, `get()`); add `live: true` to the collection so open pages follow a save. Nothing else is needed for several processes: see [Other processes and edits made outside the CMS](#other-processes-and-edits-made-outside-the-cms).

SQLite stores the JSON as written; Postgres stores `jsonb`, which reorders an object's keys and refuses `\u0000`.

### Before a save

`cms({ beforeSave })` is asked before every save, publish, unpublish, duplicate, restore, deletion and rename (not a reorder), to stamp or compute a field, or to refuse: `beforeSave: ({ collection, slug, locale, verb, data, body, previous, author, from, context }) => ...`. It follows kay's [hook convention](../../../llms/hooks.md) and returns:

- nothing: the write goes on unchanged;
- `{ data, body }`: written instead, `data` replacing the entry's whole data, so spread the one you were given: `({ data, author }) => ({ data: { ...data, updatedBy: author?.name } })`. Only the verbs that write data take it; a `delete` and a `rename` can only be refused;
- `false`, or a thrown `refuse(message, { errors, status })` from `kay`, to refuse: `refuse('A summary is needed', { errors: { summary: 'required' } })`. The entry form shows it as it shows a schema refusal, the message on the entry and each `errors` key on its field, and the API answers `{ ok: false, error, issues }` with `error.status` 422 (403 for `false`, or the `status` given). Nothing is written.

`data` is the entry about to be written and `previous` the entry as stored now (`{ data, body }`, none for a new one); for a `delete` `data` is the entry removed, and for a `rename` `slug` is the new slug, `from` the old one and `data` the entry before its references are pointed at the new slug. Any other throw refuses with 500 and `Internal server error`, after it is reported with source `cms.beforeSave`; a hook that does not finish in 10 s does the same. A change that is not `{ data: object, body: string }` is a 500 too.

The order of one write: the role checks of `roles` and `can` (in the API's guard), `fourEyes` (an approval by the person who sent the draft is refused before the publish), then `beforeSave`, then the checks of the entry (a script in the body, dangling references, `single`, its schema) on what `beforeSave` left, then the version check, which refuses a save made over someone else's with 409. So a hook sees a save the version check later refuses, and keeps no side effects of its own. The entries a rename points at the new slug are saved without being asked. `beforeSave` runs after the restrictions of `roles` (a role that may not publish saves a draft), so it can change them: keep such a rule in the hook too. A body the hook changes gets the script check even on a publish, unpublish or duplicate.

### After a save

`cms({ onSave })` runs after each save, publish, duplicate, move, restore and deletion went through, in the process that handled it: `onSave: async ({ collection, slug, locale, verb, author, commit, data, previous, context }) => { await purgeCdn(`/${collection}/${slug}`) }`. `verb` is `add`, `update`, `publish`, `unpublish`, `move` (one call per entry of a reorder), `duplicate`, `restore`, `rename` (`slug` is the new one, `from` the old) or `delete`; `commit` is what a folder entry's saver made; `data` and `body` are the entry as written, `beforeSave`'s changes included (none for a `delete` and a `move`), and `previous` the entry as it was stored (none for a new one and a `move`). A throw is reported with source `cms.onSave` and never undoes the save, and the editor waits for the hook, so keep it short: past 10 s the save answers anyway and the late hook is reported.

What is refreshed before the hook runs, with nothing to call:

- The collection's entries, and every prerendered or cached page that read them, rendered again on its next request (add `prerender: true` to a page over a loader).
- The sitemap, built again on its next request, not up to an hour later.
- Not the search index: `search: true` indexes the pages `kay build` renders, so a saved or new entry is searchable after the next build. A site needing it sooner builds on a schedule or from `onSave`.

## Reference

### The loaders

- `sqliteLoader({ name, database?, seed?, table?, ttl?, watch? })`: `database` is a file path (created with its folder, in WAL mode) or a `bun:sqlite` `Database` the app opened. Left out it is the file of the app's `store: sqliteData(path)`, else `data/content.sqlite` (a `data/content.db` that exists keeps being read, and production warns once when the entries go to a local file).
- `pgLoader({ name, source?, seed?, table?, ttl?, watch? })` from `@kayjs/cms/pg`: `source` is a connection URL, a Bun `SQL` or a pg-orm `Database`, and the url of the app's `store: pgData(url)` when left out; `sql` is its deprecated name. A pg-orm app passes its own database, `source: db`, and lists the loader's table in `ignoreTables` (`db.sync({ ignoreTables: ['kay_content'] })` and `pg-orm.config.ts`), as pg-orm would otherwise see it as a table to drop. A URL opens one pool shared by every loader using it.
- Both give the loader's `load`, `count`, `get`, `save`, `saveMany` and `remove`, so the screens, the on-page editor, Publish, Delete and a reorder work with nothing else declared.
- Every collection of the app can share the table (`kay_content` by default, `table` names another, a plain identifier): its rows are keyed by the loader's `name`.
- The table is created on the first read or save, and a failed start is tried again by the next call. Postgres processes starting together take an advisory lock, so one creates the table and seeds.
- `seed` is a list of `{ slug, locale?, data, body? }`, or a function returning one (processes starting together may each run it, one writing the result). It is written once per collection, when the table holds no seed marker for it, never again, so an entry an editor deleted stays deleted and a changed seed does not overwrite the editors' work. A collection with no `seed` starts empty.
- `data` is stored as JSON, as `save` hands it: a date is its ISO text. In a localized collection an entry's place is `<locale>/<slug>`.
- A save with `create: true` throws `<name>: <place> exists already` when the entry exists, so two editors creating one slug never overwrite each other.
- A reorder, or any save of several entries, goes through `saveMany`: one transaction, so a failure leaves every entry as it was. `saveEntries(name, entries)` from `kay/content` is the call; a loader without `saveMany` gets the entries one `save` at a time. A reorder of the shipped loaders writes only each entry's order field, and only if it still holds the number the editor read, so a save or a move of another process in between refuses the reorder ("changed since you opened it") and is never undone; `expect` in [Loaders](../../../llms/content-cms.md) is how a loader of your own does the same.

### Other processes and edits made outside the CMS

A save refreshes the collection in the process that handled it, and each loader looks at its database for changes of its own, so the others follow with nothing declared:

- `watch` is how often it looks, `'1s'` for SQLite (`PRAGMA data_version`, which moves when another connection committed, then a hash of the collection's rows, so a write to another collection changes nothing) and `'2s'` for Postgres (the collection's row count and the sum of the transactions that wrote them); `false` looks no more. The timer never keeps the process alive and starts with the first read.
- A collection nobody edits is looked at less and less: after 8 looks that found nothing the delay doubles up to 5 s (never under `watch` itself), and a save made here or a change found brings it back to `watch`. On Postgres each save also sends a `NOTIFY` that wakes every other process's look at once, and while notifications are known to arrive the idle look is every 30 s, only the fallback of a lost one. A hand edit made with `psql` sends none, so it shows within 30 s; a database that refuses `LISTEN` (a pooler in transaction mode) keeps the 5 s polling.
- A change found drops the collection's entries as a save does: the next read loads them afresh, the pages that read them and the sitemap are refreshed, `live: true` pages follow in every tab, and a `publishAt` or `unpublishAt` date is read again. A save made here is not looked for again, and each process finds an outside change by itself, so nothing is broadcast for it. On Postgres a rewrite of the rows that changed nothing, such as `VACUUM FREEZE`, is not a change.
- The same finds an edit made outside the CMS, a row changed with `sqlite3` or `psql`, a script or another app: it shows within `watch`, with no reload command, admin refresh or webhook to wire.
- `ttl` is no longer needed for this: it still refreshes the entries when a change goes unseen, such as a loader of your own. A folder collection or an API behind a loader of your own has no database to look at: call `posts.invalidate()` from a webhook route ([Content from a CMS](../../../llms/content-cms.md)), or restart.
- A page with `publishAt` or `unpublishAt` is checked on the clock of each process, so replicas need no job; a save in one process reaches the others through `watch`, which has them read the dates again.
