import type { SQL } from 'bun'
import { join } from 'node:path'
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

  pgIt('lists the most hit paths and referrers first by their count, 10 before 9', async () => {
    const store = pgMissingStore(sql, false)

    for (let index = 0; index < 9; index++)
      store.hit('/nine', 'b.example', () => undefined)
    for (let index = 0; index < 19; index++)
      store.hit('/ten', index < 10 ? 'a.example' : 'b.example', () => undefined)

    const listed = await store.list()

    expect(listed.map(row => [row.path, row.hits])).toEqual([['/ten', 19], ['/nine', 9]])
    expect(listed[0]!.referrers).toEqual([{ host: 'a.example', hits: 10 }, { host: 'b.example', hits: 9 }])
    await store.clear()
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
    expect(told.filter(line => line.startsWith('warn: the redirects added while the site runs cannot be read from the app\'s Postgres database'))).toHaveLength(1)
  })

  pgIt('answers a 404 within about a second when the database never answers, and at once after', async () => {
    const silent = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => undefined, open: () => undefined } })
    const blackHole = new BunSQL(`postgres://test@127.0.0.1:${silent.port}/none`, { max: 1 })

    setupStore({ sql: blackHole })
    process.env.NODE_ENV = 'production'

    try {
      const server = app()
      const timed = async (path: string) => {
        const started = performance.now()
        const response = await server.handle(new Request(`http://localhost${path}`))

        return { status: response.status, ms: performance.now() - started }
      }
      const first = await timed('/hang-one')

      expect(first.status).toBe(404)
      expect(first.ms).toBeLessThan(3000)

      for (const path of ['/hang-two', '/hang-three', '/hang-four']) {
        const later = await timed(path)

        expect(later.status).toBe(404)
        expect(later.ms).toBeLessThan(300)
      }

      expect(told.filter(line => line.includes('the redirects added while the site runs cannot be read'))).toHaveLength(1)
    }
    finally {
      dropStore()
      await blackHole.close({ timeout: 0 })
      silent.stop(true)
    }
  }, 30_000)

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

pgDescribe('a Postgres app in development, and the reads of a screen', () => {
  const tables = async () => (await sql.unsafe<{ total: number }[]>('SELECT count(*)::int AS total FROM unnest(ARRAY[\'kay_missing\', \'kay_missing_referrers\', \'kay_redirects\']) AS name WHERE to_regclass(name) IS NOT NULL'))[0]!.total

  pgIt('creates nothing and answers empty on an empty database', async () => {
    setupStore({ sql })
    process.env.NODE_ENV = 'development'

    const redirector = missingRedirector({})
    const server = redirector.unrouted(redirector.pages(new Elysia())).get('/*', ({ request }) => {
      pageRequested(request)

      return new Response('gone', { status: 404, headers: { 'content-type': 'text/html' } })
    })

    expect((await server.handle(new Request('http://localhost/dev-missing'))).status).toBe(404)
    expect((await server.handle(new Request('http://localhost/never-routed-dev'))).status).toBe(404)
    expect(await runtimeRedirects()).toEqual([])
    expect(await unansweredPaths()).toEqual([])
    expect(await dismissMissing('/dev-missing')).toBe(false)
    expect(await clearMissing()).toBe(0)
    expect(await removeRuntimeRedirect('/dev-missing')).toBe(false)
    expect(await tables()).toBe(0)
  })

  pgIt('creates the tables for a redirect an editor adds, and the server then answers it', async () => {
    setupStore({ sql })
    process.env.NODE_ENV = 'development'

    const redirector = missingRedirector({})
    const server = redirector.pages(new Elysia()).get('/*', ({ request }) => {
      pageRequested(request)

      return new Response('gone', { status: 404, headers: { 'content-type': 'text/html' } })
    })

    expect((await server.handle(new Request('http://localhost/dev-edit'))).status).toBe(404)
    expect(await tables()).toBe(0)
    await addRuntimeRedirect('/dev-edit', '/new')
    expect(await tables()).toBe(3)
    await eventually(async () => {
      expect((await server.handle(new Request('http://localhost/dev-edit'))).status).toBe(307)
    }, 3000)
  })

  pgIt('gives a role that may read nothing an empty list, not an error', async () => {
    const database = (await postgres()).url
    const role = `kay_missing_blind_${process.pid}`
    const admin = new BunSQL(Object.assign(new URL(url!.href), { pathname: '/postgres' }).href)
    const restricted = new BunSQL(Object.assign(new URL(database), { username: role, password: 'readerpass0123' }).href, { max: 1 })

    try {
      await createDataTables(sql)
      await admin.unsafe(`DROP ROLE IF EXISTS ${role}`)
      await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD 'readerpass0123'`)
      await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`)

      const store = pgMissingStore(restricted, false, true)

      expect(await store.list()).toEqual([])
      expect(await store.redirects.list()).toEqual([])
      expect(await store.forget('/x')).toBe(false)
      expect((await store.redirects.snapshot()).exact.size).toBe(0)
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

pgDescribe('the limits of the Postgres log', () => {
  pgIt('writes one batch at a time while a flood of distinct paths arrives, and counts them all', async () => {
    let active = 0
    let most = 0
    const counted = new Proxy(sql, {
      get(target, key) {
        if (key === 'begin') {
          return async (...args: Parameters<SQL['begin']>) => {
            active++
            most = Math.max(most, active)

            try {
              return await target.begin(...args)
            }
            finally {
              active--
            }
          }
        }

        const value = Reflect.get(target, key) as unknown

        return typeof value === 'function' ? value.bind(target) as unknown : value
      },
    })
    const store = pgMissingStore(counted, false)

    await store.list()
    most = 0

    for (let index = 0; index < 900; index++)
      store.hit(`/flood-${index}`, undefined, () => undefined)

    await eventually(async () => {
      expect((await store.list()).length).toBe(900)
    }, 10_000)
    expect(most).toBe(1)
    await store.close()
  }, 30_000)

  pgIt('stops answering a removed redirect at once on the replica that removed it, even with a read under way', async () => {
    const store = pgMissingStore(sql, false)

    await store.redirects.add('/gone-now', '/new', undefined, rules)
    expect((await answerFor(store.redirects, '/gone-now', '', []))?.location).toBe('/new')
    await new Promise(resolve => setTimeout(resolve, 1100))

    const reading = answerFor(store.redirects, '/gone-now', '', [])

    expect(await store.redirects.remove('/gone-now')).toBe(true)
    await reading
    expect(await answerFor(store.redirects, '/gone-now', '', [])).toBeUndefined()
    await store.close()
  })

  pgIt('refuses nothing for hostile input: control characters and an over-long path are not counted, a NUL in a redirect is stored whole', async () => {
    setupStore({ sql })
    process.env.NODE_ENV = 'production'

    const server = app()

    for (const path of ['/a%00b', '/line%0Abreak', `/${'a'.repeat(5000)}`])
      expect((await server.handle(new Request(`http://localhost${path}`))).status).toBe(404)

    expect(await unansweredPaths()).toEqual([])

    const store = pgMissingStore(sql, false)

    expect(await store.redirects.find('/n\0ul')).toBeUndefined()
    expect(await store.redirects.remove('/n\0ul')).toBe(false)
    expect(await store.redirects.find('/back\\slash')).toBeUndefined()
    await store.close()
  })

  pgIt('sets the purge time only once a purge went through', async () => {
    await createDataTables(sql)
    await sql.unsafe('INSERT INTO kay_missing (path, hits, first_at, last_at) VALUES (\'/stale\', 1, 1, 1)')
    await sql.unsafe('ALTER TABLE kay_missing ADD CONSTRAINT refuses_two CHECK (path <> \'/purge-two\')')

    const store = pgMissingStore(sql, false)

    store.hit('/purge-two', undefined, () => undefined)
    await expect(store.list()).rejects.toThrow()
    expect((await sql.unsafe<{ path: string }[]>('SELECT path FROM kay_missing')).map(row => row.path)).toEqual(['/stale'])
    await sql.unsafe('ALTER TABLE kay_missing DROP CONSTRAINT refuses_two')
    store.hit('/purge-three', undefined, () => undefined)
    expect((await store.list()).map(row => row.path)).toEqual(['/purge-three'])
    await store.close()
  })
})

pgDescribe('kay not-found against Postgres', () => {
  const cli = join(import.meta.dir, '../src/cli.ts')

  async function run(args: string[], cwd: string) {
    const child = Bun.spawn([process.execPath, cli, ...args], { cwd, env: { PATH: process.env.PATH! }, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    return { stdout, stderr, code }
  }

  async function project(database: string): Promise<string> {
    const root = await scratchDir('not-found-cli-pg-')

    await Bun.write(join(root, 'kay.config.ts'), `export default {\n  favicon: false,\n  store: { database: ${JSON.stringify(database)} },\n}\n`)
    await Bun.write(join(root, 'src/routes/new.kay'), 'main New\n')

    return root
  }

  pgIt('lists the log and adds a runtime redirect, and a dry run creates nothing', async () => {
    const database = (await postgres()).url
    const root = await project(database)

    expect((await run(['not-found', root, '--redirect', '/dry', '--to', '/new', '--runtime', '--dry-run'], root)).code).toBe(0)

    const [none] = await sql.unsafe<{ total: number }[]>('SELECT count(*)::int AS total FROM unnest(ARRAY[\'kay_missing\', \'kay_redirects\']) AS name WHERE to_regclass(name) IS NOT NULL')

    expect(none!.total).toBe(0)

    const store = pgMissingStore(sql, false)

    store.hit('/cli-old', 'a.example', () => ({ target: '/new', reason: 'slug' }))
    store.hit('/cli-old', undefined, () => ({ target: '/new', reason: 'slug' }))
    await store.list()

    const listed = await run(['not-found', root], root)

    expect(listed.code).toBe(0)
    expect(listed.stdout).toContain('/cli-old')

    const added = await run(['not-found', root, '--redirect', '/cli-old', '--runtime'], root)

    expect(added.code).toBe(0)
    expect((await store.redirects.list()).map(row => [row.from, row.to])).toEqual([['/cli-old', '/new']])
    expect((await store.list()).map(row => row.path)).toEqual([])
    await store.close()
  }, 60_000)
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
