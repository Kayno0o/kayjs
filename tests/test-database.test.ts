import { readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { scratchDir } from './scratch'

const PRELOAD = join(import.meta.dir, '..', 'src', 'test', 'preload.ts')

const MIGRATION = `-- migrate:up
CREATE TABLE "member" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "name" TEXT NOT NULL UNIQUE
);

-- migrate:down
DROP TABLE IF EXISTS "member";
`

const CONFIG = `import { Database, defineConfig, defineTable } from '@kaynooo/pg-orm'

export const Member = defineTable('member', f => ({
  id: f.serial().primaryKey(),
  name: f.varchar(40).unique(),
}))

export default defineConfig({ db: new Database({ url: process.env.DATABASE_URL, tables: [Member] }), migrationsDir: 'migrations' })
`

const SEED = `import { Member } from '../pg-orm.config'

export default async function seed(db) {
  await db.repo(Member).write.insertOne({ name: 'Ada' })
}
`

// Each file adds a member of its own to its database, and reads every member back with where it is.
function members(name: string) {
  return `import { Database } from '@kaynooo/pg-orm'
import { expect, it } from 'bun:test'
import { Member } from '../pg-orm.config'

it('starts from the seed, and keeps its own rows', async () => {
  const db = new Database({ url: process.env.DATABASE_URL, tables: [Member] })

  await db.repo(Member).write.insertOne({ name: ${JSON.stringify(name)} })

  expect((await db.repo(Member).read.findMany(q => q.orderBy('name', 'asc'))).map(member => member.name)).toEqual(${JSON.stringify(name === 'Ada' ? ['Ada'] : ['Ada', name].sort())})
  console.log('URL ' + process.env.DATABASE_URL)
  await db.close()
})
`
}

async function project(seeded: boolean): Promise<string> {
  const dir = resolve(await scratchDir('test-database-'))

  await Bun.write(join(dir, 'bunfig.toml'), `[test]\npreload = [${JSON.stringify(PRELOAD)}]\n`)
  await Bun.write(join(dir, 'kay.config.ts'), 'export default {}\n')
  await Bun.write(join(dir, '.env.test'), 'DATABASE_URL=sqlite://data/test.db\n')
  await Bun.write(join(dir, 'pg-orm.config.ts'), CONFIG)
  await Bun.write(join(dir, 'migrations', '0001_member.sql'), MIGRATION)
  await Bun.write(join(dir, 'tests', 'one.test.ts'), members('Linus'))
  await Bun.write(join(dir, 'tests', 'two.test.ts'), members('Grace'))

  if (seeded)
    await Bun.write(join(dir, 'tests', 'seed.ts'), SEED)

  return dir
}

async function run(dir: string, args: string[]): Promise<{ code: number, report: string }> {
  const child = Bun.spawn([process.execPath, 'test', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, KAY_ROOT: dir } })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { code, report: out + err }
}

describe('kay/test/preload\'s database for each test file', () => {
  it('gives each file a copy of the migrated, seeded database, and drops it after, from the config alone', async () => {
    const dir = await project(true)
    const { code, report } = await run(dir, ['--isolate'])
    const urls = [...report.matchAll(/URL (\S+)/g)].map(match => match[1])

    expect(report).toContain('2 pass')
    expect(code).toBe(0)
    expect(new Set(urls).size).toBe(2)
    expect(urls.every(url => url !== 'sqlite://data/test.db')).toBe(true)
    expect(readdirSync(join(dir, 'data')).filter(file => !file.includes('_tpl_'))).toEqual([])
  }, 60_000)

  it('starts from the migrations alone with no tests/seed.ts', async () => {
    const dir = await project(false)

    await Bun.write(join(dir, 'tests', 'one.test.ts'), members('Ada'))
    await Bun.write(join(dir, 'tests', 'two.test.ts'), members('Ada'))

    const { code, report } = await run(dir, ['--isolate'])

    expect(report).toContain('2 pass')
    expect(code).toBe(0)
  }, 60_000)

  it('leaves DATABASE_URL alone in a project with no pg-orm.config.ts', async () => {
    const dir = await project(false)

    await rm(join(dir, 'pg-orm.config.ts'))
    await Bun.write(join(dir, 'tests', 'one.test.ts'), `import { expect, it } from 'bun:test'\nit('keeps the url', () => { expect(process.env.DATABASE_URL).toBe('sqlite://data/test.db') })\n`)

    const { code } = await run(dir, ['tests/one.test.ts'])

    expect(code).toBe(0)
  }, 60_000)
})
