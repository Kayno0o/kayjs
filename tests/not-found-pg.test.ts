import type { SQL } from 'bun'
import process from 'node:process'
import { SQL as BunSQL } from 'bun'
import { afterEach, beforeEach, expect } from 'bun:test'
import { Elysia } from 'elysia'
import { setupStore } from '../src/server/app-store'
import { devNotFound } from '../src/server/dev-not-found'
import { clearMissing, dismissMissing } from '../src/server/library'
import { resetLocalFiles, warnOfLocalFiles } from '../src/server/local-files'
import { adoptLocalNotFound, countMissing, dropStore, knowRedirects, missingStore, pageRequested, unansweredPaths } from '../src/server/not-found'
import { createDataTables, dataTableNames } from '../src/server/pg-data'
import { pgMissingStore } from '../src/server/pg-not-found'
import { addRuntimeRedirect, knowRuntimeRules, missingRedirector, removeRuntimeRedirect, runtimeRedirects } from '../src/server/runtime-redirect-api'
import { answerFor } from '../src/server/runtime-redirects'
import { eventually } from './helpers/eventually'
import { cleanUpAfterFile, pgDescribe, pgIt, postgres, url } from './job-stores'
import { scratchDir } from './scratch'

cleanUpAfterFile()

const SINK = Symbol.for('kay.log')
const global = globalThis as { [SINK]?: unknown }
const kept = { env: process.env.NODE_ENV, sink: global[SINK] }
const rules = { hosts: [] as string[], configured: {} as Record<string, string>, served: () => ['/new', '/other', '/target'] }
let told: string[] = []
let sql: SQL

beforeEach(async () => {
  told = []
  global[SINK] = (level: string, message: string) => told.push(`${level}: ${message}`)
  resetLocalFiles()
  knowRedirects([])
  knowRuntimeRules({ redirects: {}, served: rules.served })
  sql = (await postgres()).sql

  for (const table of dataTableNames)
    await sql.unsafe(`DROP TABLE IF EXISTS ${table}`)
})

afterEach(() => {
  dropStore()
  setupStore(undefined)
  global[SINK] = kept.sink

  if (kept.env === undefined)
    delete process.env.NODE_ENV
  else
    process.env.NODE_ENV = kept.env
})

// The app of a Postgres store: a page-less one whose every path is missing, counting and answering as the server does.
function app() {
  const redirector = missingRedirector({})

  return redirector.unrouted(redirector.pages(countMissing(new Elysia(), { known: () => ['/new', '/other', '/target'] }))).get('/*', ({ request }) => {
    pageRequested(request)

    return new Response('gone', { status: 404, headers: { 'content-type': 'text/html' } })
  })
}

pgDescribe('the 404 log in Postgres', () => {
  pgIt('counts hits with their referrers and a suggestion, and forgets and clears them', async () => {
    const store = pgMissingStore(sql, false)

    store.hit('/old', 'a.example', () => undefined)
    store.hit('/old', 'a.example/blog', () => ({ target: '/new', reason: 'slug' }))
    store.hit('/other-gone', undefined, () => undefined)

    const listed = await store.list()

    expect(listed.map(row => [row.path, row.hits, row.target, row.reason])).toEqual([['/old', 2, '/new', 'slug'], ['/other-gone', 1, undefined, undefined]])
    expect(listed[0]!.referrers).toEqual([{ host: 'a.example', hits: 1 }, { host: 'a.example', page: '/blog', hits: 1 }].sort((a, b) => b.hits - a.hits || (a.page === undefined ? -1 : 1)))

    expect(await store.forget('/old')).toBe(true)
    expect(await store.forget('/old')).toBe(false)
    expect(await store.clear()).toBe(1)
    expect(await store.list()).toEqual([])
    await store.close()
  })

  pgIt('keeps at most so many paths, forgetting the least hit', async () => {
    const store = pgMissingStore(sql, false)

    for (let index = 0; index < 1000; index++)
      store.hit(`/p${index}`, undefined, () => undefined)

    store.hit('/popular', undefined, () => undefined)
    store.hit('/popular', undefined, () => undefined)

    const listed = await store.list()

    expect(listed).toHaveLength(1000)
    expect(listed[0]!.path).toBe('/popular')
    await store.close()
  })

  pgIt('is shared by two connections, as two replicas are', async () => {
    const [first, second] = [pgMissingStore(sql, false), pgMissingStore(sql, false)]

    first.hit('/shared', undefined, () => undefined)
    second.hit('/shared', undefined, () => undefined)
    await first.list()
    await second.list()

    expect((await first.list()).map(row => [row.path, row.hits])).toEqual([['/shared', 2]])
  })

  pgIt('creates its tables with createDataTables, which pg-orm\'s ignoreTables lists', async () => {
    await createDataTables(sql)

    for (const table of ['kay_missing', 'kay_missing_referrers', 'kay_redirects'])
      expect(dataTableNames).toContain(table)

    const [found] = await sql.unsafe<{ total: number }[]>('SELECT count(*)::int AS total FROM unnest(ARRAY[\'kay_missing\', \'kay_missing_referrers\', \'kay_redirects\']) AS name WHERE to_regclass(name) IS NOT NULL')

    expect(found!.total).toBe(3)
  })

  pgIt('is told to have the owner create the tables when the role may not', async () => {
    const database = (await postgres()).url
    const role = `kay_missing_reader_${process.pid}`
    const admin = new BunSQL(Object.assign(new URL(url!.href), { pathname: '/postgres' }).href)
    const restricted = new BunSQL(Object.assign(new URL(database), { username: role, password: 'readerpass0123' }).href, { max: 1 })

    try {
      await admin.unsafe(`DROP ROLE IF EXISTS ${role}`)
      await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD 'readerpass0123'`)

      const store = pgMissingStore(restricted, false)

      await expect(store.list()).rejects.toThrow('createDataTables')
      await store.close()
    }
    finally {
      await restricted.close()
      await sql.unsafe(`DROP OWNED BY ${role}`)
      await admin.unsafe(`DROP ROLE IF EXISTS ${role}`)
      await admin.close()
    }
  }, 60_000)
})

pgDescribe('the redirects in Postgres', () => {
  pgIt('adds, finds, answers and removes them with the rules of the SQLite set', async () => {
    const { redirects } = pgMissingStore(sql, false)

    await redirects.add('/old', '/new', 301, rules)
    await redirects.add('/docs/*', '/target/*', undefined, { ...rules, served: undefined })
    await redirects.add('/retired', '', 410, rules)

    expect((await redirects.list()).map(row => [row.from, row.to, row.status]).sort()).toEqual([['/docs/*', '/target/*', 307], ['/old', '/new', 301], ['/retired', '', 410]])
    expect((await redirects.find('/old'))?.to).toBe('/new')
    expect((await redirects.patterns()).map(row => row.from)).toEqual(['/docs/*'])
    expect(await answerFor(redirects, '/old/', '?a=1', [])).toEqual({ location: '/new?a=1', status: 301 })
    expect((await answerFor(redirects, '/docs/a/b', '', []))?.location).toBe('/target/a/b')
    expect(await answerFor(redirects, '/retired', '', [])).toEqual({ location: '', status: 410 })
    expect(await answerFor(redirects, '/nothing', '', [])).toBeUndefined()

    await expect(redirects.add('/new', '/old', undefined, rules)).rejects.toThrow(/loop/)
    await expect(redirects.add('/x', '//evil.example', undefined, rules)).rejects.toThrow()
    await expect(redirects.add('/x', '/retired', undefined, rules)).rejects.toThrow(/gone/)
    expect(await redirects.remove('/old')).toBe(true)
    expect(await redirects.remove('/old')).toBe(false)
  })

  pgIt('refuses a loop between two editors adding opposite redirects at once', async () => {
    const [first, second] = [pgMissingStore(sql, false), pgMissingStore(sql, false)]
    const open = { ...rules, served: undefined }

    await first.list()

    const results = await Promise.allSettled([first.redirects.add('/a', '/b', undefined, open), second.redirects.add('/b', '/a', undefined, open)])

    expect(results.map(result => result.status).toSorted()).toEqual(['fulfilled', 'rejected'])
    expect(await first.redirects.list()).toHaveLength(1)
  })

  pgIt('moves a page: the redirects leading to it lead to the new one, and the way back is no loop', async () => {
    const { redirects } = pgMissingStore(sql, false)

    await redirects.add('/older', '/new', undefined, rules)
    await redirects.move('/new', '/other', rules)

    expect((await redirects.list()).map(row => [row.from, row.to]).sort()).toEqual([['/new', '/other'], ['/older', '/other']])

    await redirects.move('/other', '/new', rules)

    expect((await redirects.list()).map(row => [row.from, row.to]).sort()).toEqual([['/older', '/new'], ['/other', '/new']])
  })

  pgIt('holds at most 1000, and edits one in place when full', async () => {
    const { redirects } = pgMissingStore(sql, false)
    const open = { ...rules, served: undefined }

    await redirects.list()
    await sql.unsafe('INSERT INTO kay_redirects (path, target, status, pattern, added_at) SELECT \'/full-\' || n, \'/target\', 307, 0, 1 FROM generate_series(1, 1000) AS n')

    await expect(redirects.add('/one-more', '/target', undefined, open)).rejects.toThrow(/1000/)
    expect((await redirects.add('/full-1', '/other', undefined, open)).to).toBe('/other')
  })

  pgIt('dry-runs without writing', async () => {
    const { redirects } = pgMissingStore(sql, false)

    expect((await redirects.add('/dry', '/new', undefined, { ...rules, dryRun: true })).from).toBe('/dry')
    expect(await redirects.list()).toEqual([])
  })

  pgIt('shows a redirect one replica added to another within a second', async () => {
    const [first, second] = [pgMissingStore(sql, false), pgMissingStore(sql, false)]

    expect(await answerFor(second.redirects, '/seen', '', [])).toBeUndefined()
    await first.redirects.add('/seen', '/new', undefined, rules)
    await eventually(async () => {
      expect((await answerFor(second.redirects, '/seen', '', []))?.location).toBe('/new')
    }, 3000)
  })
})

pgDescribe('a Postgres app serving its 404s', () => {
  pgIt('logs a missing path, redirects an added one, and dismisses, with no local file and no warning', async () => {
    setupStore({ sql })
    process.env.NODE_ENV = 'production'

    const server = app()

    resetLocalFiles()
    warnOfLocalFiles()
    expect(told).toEqual([])

    expect((await server.handle(new Request('http://localhost/missing-pg'))).status).toBe(404)
    expect((await server.handle(new Request('http://localhost/missing-pg'))).status).toBe(404)
    await eventually(async () => {
      expect((await unansweredPaths()).map(row => [row.path, row.hits])).toEqual([['/missing-pg', 2]])
    })

    expect(await addRuntimeRedirect('/missing-pg', '/new')).toMatchObject({ from: '/missing-pg', to: '/new', status: 307 })
    expect(await unansweredPaths()).toEqual([])

    const answered = await server.handle(new Request('http://localhost/missing-pg?x=1'))

    expect([answered.status, answered.headers.get('location')]).toEqual([307, '/new?x=1'])
    expect((await runtimeRedirects()).map(row => row.from)).toEqual(['/missing-pg'])
    expect(await removeRuntimeRedirect('/missing-pg')).toBe(true)

    await server.handle(new Request('http://localhost/another-pg'))
    await eventually(async () => {
      expect((await unansweredPaths()).map(row => row.path)).toEqual(['/another-pg'])
    })
    expect(await dismissMissing(['/another-pg', '/never-listed'])).toBe(1)
    expect(await clearMissing()).toBe(0)

    const [row] = await sql.unsafe<{ total: number }[]>('SELECT count(*)::int AS total FROM kay_missing')

    expect(row!.total).toBe(0)
  })

  pgIt('keeps a visitor\'s 404 when the database cannot be reached, and says so once', async () => {
    const unreachable = new BunSQL('postgres://nobody@127.0.0.1:1/none', { max: 1, connectionTimeout: 1 })

    setupStore({ sql: unreachable })
    process.env.NODE_ENV = 'test'

    const server = app()

    expect((await server.handle(new Request('http://localhost/lost-pg'))).status).toBe(404)
    expect((await server.handle(new Request('http://localhost/lost-pg'))).status).toBe(404)
    await unreachable.close()
  })

  pgIt('lists the log in dev from a database that has the tables, and creates none in one that has not', async () => {
    setupStore({ sql })

    const root = await scratchDir('not-found-pg-dev-')

    expect(await devNotFound(root, [])).toEqual({ file: 'kay_missing', recorded: false, missing: [] })

    const [row] = await sql.unsafe<{ total: number }[]>('SELECT count(*)::int AS total FROM unnest(ARRAY[\'kay_missing\', \'kay_redirects\']) AS name WHERE to_regclass(name) IS NOT NULL')

    expect(row!.total).toBe(0)

    const store = pgMissingStore(sql, false)

    store.hit('/dev-gone', undefined, () => undefined)
    await store.list()

    expect((await devNotFound(root, [])).missing.map(row => row.path)).toEqual(['/dev-gone'])
  })
})

pgDescribe('an old data/not-found.sqlite beside a Postgres app', () => {
  pgIt('moves into the tables once, leaving the rows already there, and is renamed aside', async () => {
    const root = await scratchDir('not-found-adopt-pg-')
    const old = missingStore(`${root}/data/not-found.sqlite`, false)

    old.hit('/gone', 'example.org', () => undefined)
    old.hit('/gone', 'example.org', () => undefined)
    old.hit('/kept', undefined, () => undefined)
    old.redirects.add('/old', '/new', undefined, { hosts: [], configured: {}, served: () => ['/new'], dryRun: false })
    old.close()

    const store = pgMissingStore(sql, false)

    store.hit('/kept', undefined, () => undefined)
    store.hit('/kept', undefined, () => undefined)
    store.hit('/kept', undefined, () => undefined)
    await store.list()

    await adoptLocalNotFound({ kind: 'pg', source: sql }, root)

    expect((await store.list()).map(row => [row.path, row.hits])).toEqual([['/kept', 3], ['/gone', 2]])
    expect((await store.redirects.list()).map(row => row.from)).toEqual(['/old'])
    expect(await Bun.file(`${root}/data/not-found.sqlite`).exists()).toBe(false)
    expect(await Bun.file(`${root}/data/not-found.sqlite.migrated`).exists()).toBe(true)

    await adoptLocalNotFound({ kind: 'pg', source: sql }, root)
    expect((await store.list())).toHaveLength(2)
  })

  pgIt('stays where it is, with a warning, when the database cannot take it', async () => {
    const root = await scratchDir('not-found-adopt-pg-')
    const old = missingStore(`${root}/data/not-found.sqlite`, false)

    old.hit('/gone', undefined, () => undefined)
    old.close()

    const unreachable = new BunSQL('postgres://nobody@127.0.0.1:1/none', { max: 1, connectionTimeout: 1 })

    await adoptLocalNotFound({ kind: 'pg', source: unreachable }, root)
    await unreachable.close()

    expect(await Bun.file(`${root}/data/not-found.sqlite`).exists()).toBe(true)
    expect(told.join('\n')).toContain('could not be moved into the app\'s Postgres database')
  })
})
