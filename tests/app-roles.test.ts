import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { SQL } from 'bun'
import { afterAll, describe, expect, it } from 'bun:test'
import { APP_ROLES_SCRIPT } from '../src/templates'

// A Postgres whose user may create databases and roles, as the app template's tests take: CI sets it.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''
const url = TEST_DATABASE_URL === '' ? undefined : new URL(TEST_DATABASE_URL)
const PASSWORD = 'rolepass0123'
const DATABASE = 'kay_app_roles_test'
// CI has psql, so a missing one fails there instead of skipping.
const run = it.skipIf((url === undefined || Bun.which('psql') === null) && (process.env.CI ?? '') === '')

function connect(user: string, password: string) {
  const target = new URL(url!.href)

  target.username = user
  target.password = password
  target.pathname = `/${DATABASE}`

  return new SQL(target.href)
}

async function permission(sql: SQL, statement: string): Promise<string> {
  try {
    await sql.unsafe(statement)
  }
  catch (error) {
    return (error as { errno?: string }).errno ?? 'other'
  }

  return 'allowed'
}

describe('the app template\'s db/roles.sh', () => {
  const admin = url === undefined ? undefined : new SQL(url.href)

  afterAll(async () => {
    if (admin === undefined)
      return

    await admin.unsafe(`DROP DATABASE IF EXISTS ${DATABASE}`)
    await admin.unsafe('DROP ROLE IF EXISTS app_rw')
    await admin.close()
  })

  async function runScript(password: string): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'kay-roles-'))

    try {
      await writeFile(join(dir, 'roles.sh'), APP_ROLES_SCRIPT)

      const shell = Bun.spawn(['sh', join(dir, 'roles.sh')], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, PGHOST: url!.hostname, PGPORT: url!.port, PGPASSWORD: decodeURIComponent(url!.password), POSTGRES_USER: decodeURIComponent(url!.username), POSTGRES_DB: DATABASE, APP_DB_PASSWORD: password },
      })
      const [errors, code] = await Promise.all([new Response(shell.stderr).text(), shell.exited])

      if (code !== 0)
        throw new Error(`db/roles.sh failed:\n${errors}`)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  run('gives app_rw rows and sequences of the tables a later migration creates, and no schema change', async () => {
    await admin!.unsafe(`DROP DATABASE IF EXISTS ${DATABASE}`)
    await admin!.unsafe('DROP ROLE IF EXISTS app_rw')
    await admin!.unsafe(`CREATE DATABASE ${DATABASE}`)

    const owner = connect(decodeURIComponent(url!.username), decodeURIComponent(url!.password))

    // A table made before the role exists, as in an app adopting it.
    await owner.unsafe('CREATE TABLE "early" ("id" serial PRIMARY KEY, "name" text NOT NULL)')
    await runScript(PASSWORD)
    // Run again, with another password: the role exists already, and the password follows.
    await runScript(`${PASSWORD}2`)

    // What migrations the owner runs afterwards create: a serial and an identity column, a table in another schema.
    await owner.unsafe('CREATE TABLE "late" ("id" serial PRIMARY KEY, "name" text NOT NULL)')
    await owner.unsafe('CREATE TABLE "identity" ("id" int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, "name" text NOT NULL)')
    await owner.unsafe('CREATE SCHEMA "billing"')
    await owner.unsafe('CREATE TABLE "billing"."invoice" ("id" serial PRIMARY KEY, "total" int NOT NULL)')

    const app = connect('app_rw', `${PASSWORD}2`)

    try {
      const stale = connect('app_rw', PASSWORD)

      expect(await permission(stale, 'SELECT 1')).toBe('28P01')
      await stale.close()

      for (const table of ['"early"', '"late"', '"identity"']) {
        await app.unsafe(`INSERT INTO ${table} ("name") VALUES ('a')`)
        await app.unsafe(`UPDATE ${table} SET "name" = 'b'`)
        expect((await app.unsafe<{ name: string }[]>(`SELECT "name" FROM ${table}`)).map(row => row.name)).toEqual(['b'])
        await app.unsafe(`DELETE FROM ${table}`)
      }

      // USAGE draws ids; moving a sequence is not allowed.
      expect(await permission(app, 'SELECT setval(\'late_id_seq\', 2000000000)')).toBe('42501')
      await app.unsafe('INSERT INTO "billing"."invoice" ("total") VALUES (3)')
      expect(await app.unsafe('SELECT "total" FROM "billing"."invoice"')).toHaveLength(1)

      // 42501 is insufficient_privilege, the error code, so a statement that ran or failed otherwise shows.
      for (const statement of [
        'DROP TABLE "late"',
        'ALTER TABLE "late" ADD COLUMN "extra" int',
        'CREATE TABLE "intruder" ("id" int)',
        'CREATE TABLE "billing"."intruder" ("id" int)',
        'TRUNCATE "late"',
        'CREATE SCHEMA "intruder"',
        'DROP SCHEMA "billing" CASCADE',
        'CREATE ROLE "intruder"',
      ])
        expect([statement, await permission(app, statement)]).toEqual([statement, '42501'])
    }
    finally {
      await app.close()
      await owner.close()
    }
  }, 30_000)
})
