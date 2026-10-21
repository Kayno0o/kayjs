# Loaders and a live CMS

A site whose editors save on the running server keeps its entries in a database. kayjs-cms ships a loader for each of the two it supports, SQLite on `bun:sqlite` and Postgres on Bun's own `SQL`: no dependency to add, one table of JSON entries, no schema to write.

```ts
// src/content.config.ts
import { s } from 'kay'
import { collection } from 'kay/content'
import { sqliteLoader } from '@kaynooo/kayjs-cms/sqlite'

export const posts = collection(sqliteLoader({
  name: 'posts',
  database: 'data/content.db',
  seed: [{ slug: 'hello', data: { title: 'Hello', order: 1 }, body: 'First post.' }],
}), {
  schema: s.Object({ title: s.String(), order: s.Number() }),
  order: 'order',
})
```

- `sqliteLoader({ name, database, seed?, table?, ttl? })`: `database` is a file path (created with its folder, in WAL mode) or a `bun:sqlite` `Database` the app opened.
- `postgresLoader({ name, sql, seed?, table?, ttl? })` from `@kaynooo/kayjs-cms/postgres`: `sql` is a connection URL or a Bun `SQL`. A pg-orm app passes its own connection, `sql: db.sql`, and lists the loader's table in `ignoreTables` (`db.sync({ ignoreTables: ['kay_content'] })` and `pg-orm.config.ts`), as pg-orm would otherwise see it as a table to drop. A URL opens one pool shared by every loader using it.
- Both give the loader's `load`, `count`, `get`, `save`, `saveMany` and `remove`, so the screens, the on-page editor, Publish, Delete and a reorder work with nothing else declared.
- Every collection of the app can share the table (`kay_content` by default, `table` names another, a plain identifier): its rows are keyed by the loader's `name`.
- The table is created on the first read or save, and a failed start is tried again by the next call. Postgres processes starting together take an advisory lock, so one creates the table and seeds.
- `seed` is a list of `{ slug, locale?, data, body? }`, or a function returning one (processes starting together may each run it, one writing the result). It is written once per collection, when the table holds no seed marker for it, never again, so an entry an editor deleted stays deleted and a changed seed does not overwrite the editors' work. A collection with no `seed` starts empty.
- `data` is stored as JSON, as `save` hands it: a date is its ISO text. In a localized collection an entry's place is `<locale>/<slug>`.
- A save with `create: true` throws `<name>: <place> exists already` when the entry exists, so two editors creating one slug never overwrite each other.
- A reorder, or any save of several entries, goes through `saveMany`: one transaction, so a failure leaves every entry as it was. `saveEntries(name, entries)` from `kay/content` is the call; a loader without `saveMany` gets the entries one `save` at a time.

## Wiring a live CMS

1. `kay add cms`, and set `preview.secret` in `kay.config.ts` (edit mode is kay's preview mode).
2. Declare each editable collection over a loader as above, `order`, `draft`, `publishAt` and `localized` working as on a folder.
3. Add `cms({ guard })` to `extensions`, the guard being who may edit, such as kayjs-auth's `auth.guard({ require: 'editor' })`. A loader needs no `files` saver: that is for folder entries.
4. Put the database where a deploy keeps it: a volume for the SQLite file, the app's `DATABASE_URL` for Postgres.
5. Read the collections in pages as usual (`all()`, `get()`); add `live: true` to the collection so open pages follow a save. `ttl` on the loader refreshes the entries other processes serve.

SQLite stores the JSON as written; Postgres stores `jsonb`, which reorders an object's keys and refuses `\u0000`.

A save refreshes the collection in the process that handled it. Other processes serve their cached entries until `ttl` passes or something calls `invalidate()`.
