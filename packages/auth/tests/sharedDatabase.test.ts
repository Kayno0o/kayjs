import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database as OrmDatabase } from '@kaynooo/pg-orm'
import { SQL } from 'bun'
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { appModules, setSite } from 'kay/library'
import { auth } from '../src/pages'

const URL = process.env.KAYJS_AUTH_TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:8533/kayjs_auth_test'
const SECRET = 'a-test-secret-that-is-long-enough-for-kayjs-auth'
const reachable = await new OrmDatabase({ url: URL, tables: [] }).ping()

describe('the database of the app\'s store, shared with kayjs-auth', () => {
  test.skipIf(!reachable)('Postgres: syncs its own tables and leaves the app\'s alone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kayjs-auth-shared-'))
    const cwd = process.cwd()
    const sql = new SQL(URL)

    process.chdir(root)
    process.env.KAY_SECRET = SECRET
    process.env.NODE_ENV = 'development'
    setSite('http://localhost', 'never')

    try {
      await sql.unsafe('DROP TABLE IF EXISTS app_things')
      await sql.unsafe('CREATE TABLE app_things (id text PRIMARY KEY)')
      await sql.unsafe('INSERT INTO app_things VALUES (\'kept\')')

      const extension = auth({ captcha: false })
      const plugin = await (extension.server as (app: unknown) => Promise<unknown>)({ root, modules: await appModules(root, extension), extensions: [], database: URL })

      expect(new Elysia().use(plugin as never)).toBeDefined()
      expect(await sql.unsafe('SELECT id FROM app_things')).toEqual([{ id: 'kept' }])
      expect(await sql.unsafe('SELECT to_regclass(\'kay_users\') AS name')).toEqual([{ name: 'kay_users' }])
    }
    finally {
      await sql.unsafe('DROP TABLE IF EXISTS app_things')
      await sql.close()
      process.chdir(cwd)
      process.env.NODE_ENV = 'test'
      setSite(undefined)
      rmSync(root, { recursive: true, force: true })
    }
  })

  // Two processes on one SQLite file, as `kay auth create-user` runs beside the server.
  // Skipped until pg-orm 7.1.2, whose wait on SQLITE_BUSY covers opening the file (#2020 box 3).
  test.skip('two processes writing one SQLite file wait for each other instead of answering SQLITE_BUSY', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kayjs-auth-busy-'))
    const file = join(dir, 'shared.sqlite')

    try {
      const worker = join(import.meta.dir, 'helpers/writeUsers.ts')

      const runs = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => Bun.spawn([process.execPath, worker, file, id, '60'], { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' }))
      const results = await Promise.all(runs.map(async run => ({ code: await run.exited, err: await new Response(run.stderr).text() })))

      expect(results.map(result => result.err)).toEqual(results.map(() => ''))
      expect(results.map(result => result.code)).toEqual(results.map(() => 0))

      const check = new Database(file, { readonly: true })

      expect(check.query('SELECT count(*) AS n FROM kay_users').get()).toEqual({ n: 360 })
      check.close()
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
