import type { ContentLoader } from 'kay/content'
import type { SeedEntry } from '../src/loaders/shared'
import { join } from 'node:path'
import { SQL } from 'bun'
import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { s } from 'kay'
import { collection } from 'kay/content'
import { scratchDir } from 'kay/test'
import { pgLoader } from '../src/loaders/pg'
import { sqliteLoader } from '../src/loaders/sqlite'

const seed: SeedEntry[] = [
  { slug: 'a', data: { title: 'A', order: 1 }, body: 'about a' },
  { slug: 'b', data: { title: 'B', order: 2 } },
  { slug: 'x', locale: 'fr', data: { title: 'X' } },
]

const url = process.env.TEST_DATABASE_URL ?? ''
const skipPostgres = url === ''
const admin = skipPostgres ? undefined : new SQL(Object.assign(new URL(url), { pathname: '/postgres' }).href)
const database = `kay_cms_loaders_${process.pid}`
let shared: SQL | undefined

// Each loader kind runs the same cases: `make` gives a loader on a fresh table, and a second one on the same table, as another process would.
function contract(label: string, make: (options: { name: string, seed?: SeedEntry[] | (() => SeedEntry[]) | undefined, table?: string | undefined }) => ContentLoader, test2: typeof test) {
  describe(label, () => {
    test2('seeds the first read and gives the entries by place', async () => {
      const loader = make({ name: 'posts', seed, table: 'seeded' })

      expect((await loader.load({ preview: false })).map(entry => entry.slug)).toEqual(['a', 'b', 'fr/x'])
      expect(await loader.count!({ preview: false })).toBe(3)
      expect(await loader.get!('a', { preview: false })).toEqual({ slug: 'a', data: { title: 'A', order: 1 }, body: 'about a' })
      expect(await loader.get!('fr/x', { preview: false })).toEqual({ slug: 'fr/x', data: { title: 'X' } })
      expect(await loader.get!('gone', { preview: false })).toBeUndefined()
    })

    test2('seeds once: a deleted entry stays deleted, and a second loader does not seed again', async () => {
      let calls = 0
      const options = { name: 'once', table: 'once_t', seed: () => {
        calls++

        return seed
      } }
      const first = make(options)

      await first.remove!({ slug: 'a' })
      await first.remove!({ slug: 'b' })
      await first.remove!({ slug: 'x', locale: 'fr' })

      const second = make(options)

      expect(await second.load({ preview: false })).toEqual([])
      expect(calls).toBe(1)
    })

    test2('gives a hidden sibling in the same table that the collection never lists', async () => {
      const posts = make({ name: 'posts', seed, table: 'siblings' })
      const history = posts.sibling!('history')

      await history.save!({ slug: 'a', data: { revisions: [1] } })
      expect(await history.get!('a', { preview: false })).toEqual({ slug: 'a', data: { revisions: [1] } })
      expect((await posts.load({ preview: false })).map(entry => entry.slug)).toEqual(['a', 'b', 'fr/x'])
      expect(await history.count!({ preview: false })).toBe(1)
      await history.remove!({ slug: 'a' })
      expect(await history.load({ preview: false })).toEqual([])
    })

    test2('keeps collections apart in one table', async () => {
      const posts = make({ name: 'posts', seed, table: 'apart' })
      const pages = make({ name: 'pages', seed: [{ slug: 'home', data: { title: 'Home' } }], table: 'apart' })

      expect((await posts.load({ preview: false })).length).toBe(3)
      expect((await pages.load({ preview: false })).map(entry => entry.slug)).toEqual(['home'])
    })

    test2('saves, overwrites and refuses a create over an existing entry', async () => {
      const loader = make({ name: 'posts', table: 'saves' })

      await loader.save!({ slug: 'n', data: { title: 'N' }, body: 'hello', create: true })
      await loader.save!({ slug: 'n', data: { title: 'N2' } })

      expect(await loader.get!('n', { preview: false })).toEqual({ slug: 'n', data: { title: 'N2' } })
      await expect(loader.save!({ slug: 'n', data: { title: 'N3' }, create: true })).rejects.toThrow('exists already')
      expect(await loader.get!('n', { preview: false })).toEqual({ slug: 'n', data: { title: 'N2' } })
      await loader.save!({ slug: 'n', locale: 'fr', data: { title: 'Fr' } })
      expect((await loader.load({ preview: false })).map(entry => entry.slug)).toEqual(['fr/n', 'n'])
    })

    test2('applies several entries all or none', async () => {
      const loader = make({ name: 'posts', table: 'batch', seed })

      await loader.saveMany!([{ slug: 'a', data: { title: 'A', order: 2 } }, { slug: 'b', data: { title: 'B', order: 1 } }])
      expect((await loader.get!('a', { preview: false }))!.data).toEqual({ title: 'A', order: 2 })
      expect((await loader.get!('b', { preview: false }))!.data).toEqual({ title: 'B', order: 1 })

      const unserializable: Record<string, unknown> = {}

      unserializable.self = unserializable
      await expect(loader.saveMany!([{ slug: 'a', data: { title: 'half', order: 9 } }, { slug: 'b', data: unserializable }])).rejects.toThrow()
      expect((await loader.get!('a', { preview: false }))!.data).toEqual({ title: 'A', order: 2 })
    })

    test2('refuses a table that is not a plain identifier', () => {
      expect(() => make({ name: 'posts', table: 'x; drop table y' })).toThrow('plain identifier')
    })
  })
}

contract('sqliteLoader', (options) => {
  const handle = sharedSqlite()

  return sqliteLoader({ ...options, database: handle })
}, test)

let db: Database | undefined

function sharedSqlite(): Database {
  db ??= new Database(':memory:')

  return db
}

describe('sqliteLoader files', () => {
  test('creates the file with its folder', async () => {
    const path = join(await scratchDir('loader-'), 'nested/content.db')
    const loader = sqliteLoader({ name: 'posts', database: path, seed })

    expect((await loader.load({ preview: false })).length).toBe(3)
    expect(await Bun.file(path).exists()).toBe(true)
  })
})

const postgresTest = test.skipIf(skipPostgres)

contract('pgLoader', (options) => {
  shared ??= new SQL(Object.assign(new URL(url), { pathname: `/${database}` }).href, { max: 4 })

  return pgLoader({ ...options, sql: shared })
}, postgresTest)

if (admin !== undefined) {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
  await admin.unsafe(`CREATE DATABASE ${database}`)
}

afterAll(async () => {
  await shared?.close()
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
  await admin?.close()
})

describe('as a collection', () => {
  test('reads the seeded entries through kay, typed from the schema', async () => {
    const posts = collection(sqliteLoader({ name: 'posts', database: ':memory:', seed }), { schema: s.Object({ title: s.String(), order: s.Optional(s.Number()) }), order: 'order' })

    expect((await posts.all()).map(post => post.data.title)).toEqual(['A', 'B', 'X'])
  })
})

const schema = s.Object({ title: s.String() })

// Waits for the collection's titles to be what `wanted` lists, for a watcher's interval to pass.
async function titlesBecome(posts: { all: () => Promise<{ data: { title: string } }[]> }, wanted: string[]) {
  let titles: string[] = []

  for (let wait = 0; wait < 100; wait++) {
    titles = (await posts.all()).map(post => post.data.title).toSorted()

    if (titles.join() === wanted.join())
      return titles

    await Bun.sleep(30)
  }

  return titles
}

// How many times a collection over the loader reads its entries while `run` goes, and a moment after: more than the first means something dropped them.
async function readsDuring(loader: ContentLoader, run: () => Promise<void>): Promise<number> {
  let reads = 0
  const posts = collection({ ...loader, load: async (context) => {
    reads++

    return loader.load(context)
  } }, { schema })

  await posts.all()
  await run()
  await Bun.sleep(250)
  await posts.all()

  return reads
}

describe('a loader watching its database', () => {
  test('sqlite follows a save and a hand edit made through another connection, and not its own', async () => {
    const path = join(await scratchDir('loader-'), 'watch.db')
    const posts = collection(sqliteLoader({ name: 'watched-sqlite', database: path, watch: '40ms', seed: [{ slug: 'a', data: { title: 'A' } }] }), { schema })

    expect((await posts.all()).map(post => post.data.title)).toEqual(['A'])

    const other = new Database(path)
    const elsewhere = sqliteLoader({ name: 'watched-sqlite', database: other })

    await elsewhere.save!({ slug: 'b', data: { title: 'B' } })
    expect(await titlesBecome(posts, ['A', 'B'])).toEqual(['A', 'B'])
    other.run(`UPDATE kay_content SET data = '{"title":"Edited"}' WHERE collection = 'watched-sqlite' AND place = 'a'`)
    expect(await titlesBecome(posts, ['B', 'Edited'])).toEqual(['B', 'Edited'])
    other.run(`DELETE FROM kay_content WHERE collection = 'watched-sqlite' AND place = 'b'`)
    expect(await titlesBecome(posts, ['Edited'])).toEqual(['Edited'])

    const own = sqliteLoader({ name: 'watched-own', database: path, watch: '40ms' })

    expect(await readsDuring(own, async () => own.save!({ slug: 'x', data: { title: 'X' } }))).toBe(1)
    other.close()
  })

  test('a write to another collection of the file invalidates nothing', async () => {
    const path = join(await scratchDir('loader-'), 'two.db')
    const pages = sqliteLoader({ name: 'two-pages', database: path, watch: '40ms' })
    const posts = sqliteLoader({ name: 'two-posts', database: new Database(path) })

    expect(await readsDuring(pages, async () => posts.save!({ slug: 'p', data: { title: 'P' } }))).toBe(1)
  })

  test('watch: false looks no more', async () => {
    const path = join(await scratchDir('loader-'), 'quiet.db')
    const quiet = sqliteLoader({ name: 'quiet', database: path, watch: false })

    expect(await readsDuring(quiet, async () => {
      const other = new Database(path)

      other.run(`INSERT INTO kay_content (collection, place, data) VALUES ('quiet', 'z', '{}')`)
      other.close()
    })).toBe(1)
  })

  postgresTest('postgres follows a save and a hand edit made through another connection, and not its own', async () => {
    shared ??= new SQL(Object.assign(new URL(url), { pathname: `/${database}` }).href, { max: 4 })

    const posts = collection(pgLoader({ name: 'watched-pg', sql: shared, table: 'watched', watch: '40ms', seed: [{ slug: 'a', data: { title: 'A' } }] }), { schema })

    expect((await posts.all()).map(post => post.data.title)).toEqual(['A'])

    const other = new SQL(Object.assign(new URL(url), { pathname: `/${database}` }).href, { max: 1 })

    try {
      await pgLoader({ name: 'watched-pg', sql: other, table: 'watched' }).save!({ slug: 'b', data: { title: 'B' } })
      expect(await titlesBecome(posts, ['A', 'B'])).toEqual(['A', 'B'])
      await other.unsafe(`UPDATE watched SET data = '{"title":"Edited"}' WHERE collection = 'watched-pg' AND place = 'a'`)
      expect(await titlesBecome(posts, ['B', 'Edited'])).toEqual(['B', 'Edited'])
      await other.unsafe(`DELETE FROM watched WHERE collection = 'watched-pg' AND place = 'b'`)
      expect(await titlesBecome(posts, ['Edited'])).toEqual(['Edited'])

      const own = pgLoader({ name: 'watched-pg-own', sql: shared, table: 'watched', watch: '40ms' })

      expect(await readsDuring(own, async () => own.save!({ slug: 'x', data: { title: 'X' } }))).toBe(1)
    }
    finally {
      await other.close()
    }
  })
})
