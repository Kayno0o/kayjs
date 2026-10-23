import type { LiveStore } from '../src/runtime/live-value'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { SQL } from 'bun'
import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { setLiveStore } from '../src/runtime/live-value'
import { createDataTables, pages, pgData } from '../src/server'
import { setupStore } from '../src/server/app-store'
import { pgHandle } from '../src/server/pg-data'
import { pgDescribe, pgIt, url } from './job-stores'
import { scratchDir } from './scratch'

const CLI = join(import.meta.dir, '../src/cli.ts')
const TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
  include: ['src', '.kay/types'],
})
const CONFIG = 'import { defineConfig, pgData } from \'kay/server\'\n\nexport default defineConfig({ log: false, store: pgData(process.env.PG_LIVE_SETUP_URL!) })\n'
// Nothing listens on port 1, so a connection to it is refused at once.
const UNREACHABLE = 'postgres://test:test@127.0.0.1:1/none'
const roots: string[] = []
let databases = 0
const URL_KEY = 'PG_LIVE_SETUP_URL'
const before = process.env[URL_KEY]

process.env[URL_KEY] = UNREACHABLE

afterAll(async () => {
  if (before === undefined)
    delete process.env[URL_KEY]
  else
    process.env[URL_KEY] = before

  await Promise.all(roots.map(async root => rm(root, { recursive: true, force: true })))
})

afterEach(() => {
  setupStore(undefined)
  setLiveStore(undefined)
})

// The config of an in-process start reads it too, and the store the test gives wins.

async function project(): Promise<string> {
  const root = await scratchDir('pg-live-setup-')

  roots.push(root)
  await Promise.all(Object.entries({ 'tsconfig.json': TSCONFIG, 'kay.config.ts': CONFIG, 'src/routes/index.kay': 'h1 Home\n' }).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

async function kay(root: string, database: string, ...args: string[]): Promise<{ code: number, text: string }> {
  const child = Bun.spawn([process.execPath, CLI, ...args, root], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production', PG_LIVE_SETUP_URL: database } })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { code, text: `${out}${err}` }
}

// A database of its own, dropped afterwards, and the kay tables it holds.
async function withDatabase(run: (database: string, tables: () => Promise<string[]>) => Promise<void>): Promise<void> {
  const name = `kay_live_setup_${process.pid}_${++databases}`
  const admin = new SQL(Object.assign(new URL(url!.href), { pathname: '/postgres' }).href)
  const address = Object.assign(new URL(url!.href), { pathname: `/${name}` }).href

  await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  await admin.unsafe(`CREATE DATABASE ${name}`)

  const sql = new SQL(address, { max: 1 })

  try {
    await run(address, async () => (await sql.unsafe<{ tablename: string }[]>('SELECT tablename FROM pg_tables WHERE tablename LIKE \'kay\\_%\'')).map(row => row.tablename))
  }
  finally {
    await sql.close()
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await admin.close()
  }
}

describe('a build or a check with a pgData store', () => {
  it('builds a static site without connecting when the database is unreachable', async () => {
    const root = await project()
    const { code, text } = await kay(root, UNREACHABLE, 'build', '--static', '--no-check')

    expect(code, text).toBe(0)
  }, 60_000)

  it('builds without connecting when the database is unreachable', async () => {
    const { code, text } = await kay(await project(), UNREACHABLE, 'build', '--no-check')

    expect(code, text).toBe(0)
  }, 60_000)

  pgIt('creates no kay table in a static build', async () => {
    await withDatabase(async (database, tables) => {
      const { code, text } = await kay(await project(), database, 'build', '--static', '--no-check')

      expect(code, text).toBe(0)
      expect(await tables()).toEqual([])
    })
  }, 60_000)

  pgIt('creates no kay table in kay check', async () => {
    await withDatabase(async (database, tables) => {
      const { code, text } = await kay(await project(), database, 'check')

      expect(code, text).toBe(0)
      expect(text).not.toContain('ECONNREFUSED')
      expect(await tables()).toEqual([])
    })
  }, 60_000)

  it('checks without connecting when the database is unreachable', async () => {
    const { code, text } = await kay(await project(), UNREACHABLE, 'check')

    expect(code, text).toBe(0)
    expect(text).not.toContain('ECONNREFUSED')
  }, 60_000)
})

describe('a server starting with a pgData store', () => {
  const stored = (reads: string[], fails = false): LiveStore => ({
    entries: async () => {
      reads.push('entries')

      if (fails)
        throw new Error('connection refused')

      return []
    },
    set: () => undefined,
    delete: () => undefined,
    subscribe: () => undefined,
  })

  async function start(options: { dev?: boolean, live: LiveStore }) {
    const root = await project()

    return pages({ root, routes: join(root, 'src/routes'), prebuilt: false, security: false, dev: options.dev, store: { live: options.live } })
  }

  it('reads the live values before serving, in production', async () => {
    const reads: string[] = []

    await start({ live: stored(reads) })
    expect(reads).toEqual(['entries'])
  }, 60_000)

  it('reads them in development too', async () => {
    const reads: string[] = []

    await start({ dev: true, live: stored(reads) })
    expect(reads).toEqual(['entries'])
  }, 60_000)

  it('fails its start when the database cannot be read', async () => {
    const reads: string[] = []

    await expect(start({ live: stored(reads, true) })).rejects.toThrow('connection refused')
  }, 60_000)
})

pgDescribe('a server starting against Postgres', () => {
  pgIt('creates the kay tables and reads the live rows', async () => {
    await withDatabase(async (database, tables) => {
      const root = await project()

      await pages({ root, routes: join(root, 'src/routes'), prebuilt: false, security: false, store: pgData(database) })
      expect(await tables()).toContain('kay_live')
    })
  }, 60_000)
})

pgDescribe('a pgData role that may not alter tables', () => {
  pgIt('is told to run createDataTables again when kay_live predates expires_at', async () => {
    await withDatabase(async (database) => {
      const role = `kay_live_reader_${process.pid}`
      const owner = new SQL(database, { max: 1 })
      const admin = new SQL(Object.assign(new URL(url!.href), { pathname: '/postgres' }).href)
      const restricted = new SQL(Object.assign(new URL(database), { username: role, password: 'readerpass0123' }).href, { max: 1 })

      try {
        await createDataTables(owner)
        await owner.unsafe('ALTER TABLE kay_live DROP COLUMN expires_at')
        await admin.unsafe(`DROP ROLE IF EXISTS ${role}`)
        await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD 'readerpass0123'`)
        await owner.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`)
        await expect(pgHandle(restricted).db()).rejects.toThrow('run `await createDataTables(db)`')
        await createDataTables(owner)
        expect((await owner.unsafe<{ found: number }[]>('SELECT 1 AS found FROM pg_attribute WHERE attrelid = \'kay_live\'::regclass AND attname = \'expires_at\' AND NOT attisdropped')).length).toBe(1)
        await expect(pgHandle(restricted).db()).resolves.toBeDefined()
      }
      finally {
        await restricted.close()
        await owner.unsafe(`DROP OWNED BY ${role}`)
        await admin.unsafe(`DROP ROLE IF EXISTS ${role}`)
        await owner.close()
        await admin.close()
      }
    })
  }, 60_000)

  pgIt('refuses to boot on a database another app owns, and boots on its own or an adopted one', async () => {
    await withDatabase(async (database) => {
      const first = await project()
      const second = await project()

      await Bun.write(join(first, 'package.json'), JSON.stringify({ name: 'shop' }))
      await Bun.write(join(second, 'package.json'), JSON.stringify({ name: 'blog' }))

      const boot = async (root: string) => {
        const before = process.env.KAY_ROOT

        process.env.KAY_ROOT = root

        try {
          await pages({ root, routes: join(root, 'src/routes'), prebuilt: false, security: false, store: pgData(database) })
        }
        finally {
          if (before === undefined)
            delete process.env.KAY_ROOT
          else
            process.env.KAY_ROOT = before
        }
      }

      await boot(first)
      await boot(first)
      await expect(boot(second)).rejects.toThrow('belongs to the app "shop"')
    })
  }, 60_000)
})
