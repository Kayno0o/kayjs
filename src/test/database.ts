import type { Database, PgOrmConfig } from '@kaynooo/pg-orm'
import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { afterAll } from 'bun:test'
import { isolatedRun } from './isolation'

type Seed = (db: Database) => Promise<void> | void

// An app with a `pg-orm.config.ts` and a `DATABASE_URL` gets a database of its own for each test file: a copy of the one its migrations build, seeded by the default export of `tests/seed.ts` when there is one, with `DATABASE_URL` pointing at the copy and the copy dropped once the file is done.
// Run before the app's modules, which read `DATABASE_URL` as they load, and importing only the config and the seed, which name the tables.
export async function copyTestDatabase(root: string): Promise<void> {
  const url = process.env.DATABASE_URL
  const configFile = resolve(root, 'pg-orm.config.ts')

  if (url === undefined || url === '' || !existsSync(configFile))
    return

  // Without isolation every file reads the one copy and meets the others' rows with no message.
  if (isolatedRun() === false)
    throw new Error('kay: this project has a test database, which every test file would share without isolation and see each other\'s rows in: run the tests as `kay test`, or `bun test --isolate`')

  const { testDatabase } = await import('@kaynooo/pg-orm')
  const { db, migrationsDir = 'migrations' } = (await import(configFile) as { default: Partial<PgOrmConfig> | undefined }).default ?? {}

  if (db === undefined)
    throw new Error('kay: pg-orm.config.ts must export default defineConfig({ db, migrationsDir }), which kay/test/preload reads the tables from')

  const seedFile = resolve(root, 'tests', 'seed.ts')
  const seed = existsSync(seedFile) ? (await import(seedFile) as { default?: Seed }).default : undefined

  if (existsSync(seedFile) && typeof seed !== 'function')
    throw new Error('kay: tests/seed.ts must export default a function taking the database')

  const database = await testDatabase({ url, migrationsDir: resolve(root, migrationsDir), tables: [...db.getTablesRegistry().values()], ...seed && { seed } })

  process.env.DATABASE_URL = database.url

  // Closed before it is forgotten: the config's `db` was built on the original url and nothing else will end its connections.
  await db.close()

  // The app's own modules (`./src/db`) were built on the original url, whether the config or an earlier preload loaded them: forgetting them makes the test file's imports build them again on the copy. `require.cache` holds real paths, so a root reached through a symlink is compared by both names, and kay's own modules stay, as they hold state.
  const roots = new Set([root, realpathSync(root)])
  const own = `${resolve(import.meta.dir, '..')}/`

  for (const path of Object.keys(require.cache)) {
    if (!path.startsWith(own) && !path.includes('/node_modules/') && [...roots].some(prefix => path.startsWith(`${prefix}/`)))
      delete require.cache[path]
  }

  afterAll(async () => {
    await database.drop()
  })
}
