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
// The database the URL names may not exist, so the test creates and drops its own from the cluster's `postgres` one.
const adminUrl = url === undefined ? undefined : Object.assign(new URL(url.href), { pathname: '/postgres' })
const PASSWORD = 'rolepass0123'
const DATABASE = 'kay_app_roles_test'
// CI has psql, so a missing one fails there instead of skipping: the workflows set CI.
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
  const admin = adminUrl === undefined ? undefined : new SQL(adminUrl.href)

  afterAll(async () => {
    if (admin === undefined)
      return

    // FORCE ends what a failed test left connected, which would refuse the drop.
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`)
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
    await admin!.unsafe(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`)
    await admin!.unsafe('DROP ROLE IF EXISTS app_rw')
    await admin!.unsafe(`CREATE DATABASE ${DATABASE}`)

    const owner = connect(decodeURIComponent(url!.username), decodeURIComponent(url!.password))

    // A table made before the role exists, as in an app adopting it.
    await owner.unsafe('CREATE TABLE "early" ("id" serial PRIMARY KEY, "name" text NOT NULL)')
    // The migration history table, there before the script as in an app adopting it.
    await owner.unsafe('CREATE TABLE "_pgorm_migrations" ("id" serial PRIMARY KEY, "name" text NOT NULL)')
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
      // A cluster trusting local connections (CI's) takes any password, so the old one is only refused where passwords are checked.
      const wrong = connect(decodeURIComponent(url!.username), 'not the password')
      const checksPasswords = await permission(wrong, 'SELECT 1') === '28P01'
      const stale = connect('app_rw', PASSWORD)

      await wrong.close()

      try {
        expect(await permission(stale, 'SELECT 1')).toBe(checksPasswords ? '28P01' : 'allowed')
      }
      finally {
        await stale.close()
      }

      for (const table of ['"early"', '"late"', '"identity"']) {
        await app.unsafe(`INSERT INTO ${table} ("name") VALUES ('a')`)
        await app.unsafe(`UPDATE ${table} SET "name" = 'b'`)
        expect((await app.unsafe<{ name: string }[]>(`SELECT "name" FROM ${table}`)).map(row => row.name)).toEqual(['b'])
        await app.unsafe(`DELETE FROM ${table}`)
      }

      // The history table is read, never written: the one the script found, and the one a later migrate run creates after it.
      for (const created of ['found', 'created later']) {
        if (created === 'created later') {
          await owner.unsafe('DROP TABLE "_pgorm_migrations"')
          await owner.unsafe('CREATE TABLE "_pgorm_migrations" ("id" serial PRIMARY KEY, "name" text NOT NULL)')
        }

        await owner.unsafe('INSERT INTO "_pgorm_migrations" ("name") VALUES (\'0001\')')
        expect([created, (await app.unsafe<{ name: string }[]>('SELECT "name" FROM "_pgorm_migrations"')).map(row => row.name)]).toEqual([created, ['0001']])

        for (const statement of ['INSERT INTO "_pgorm_migrations" ("name") VALUES (\'0002\')', 'UPDATE "_pgorm_migrations" SET "name" = \'x\'', 'DELETE FROM "_pgorm_migrations"', 'TRUNCATE "_pgorm_migrations"'])
          expect([created, statement, await permission(app, statement)]).toEqual([created, statement, '42501'])

        await owner.unsafe('DELETE FROM "_pgorm_migrations"')
      }

      // Only that table: a name that matches it as a pattern keeps its rows writable.
      await owner.unsafe('CREATE TABLE "xpgorm_migrations" ("id" serial PRIMARY KEY, "name" text NOT NULL)')
      await app.unsafe('INSERT INTO "xpgorm_migrations" ("name") VALUES (\'a\')')

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
