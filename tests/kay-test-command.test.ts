import { join, resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { scratchDir } from './scratch'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')

const ROUTE = `--- server
export function add(a: number, b: number) {
  return a + b
}
export function boom() {
  throw new Error('kaboom')
}
---
h1 Hi
`

const COUNTER = `---
import { signal } from 'kay'

const count = signal(0)
---
button(onClick={() => count.set(n => n + 1)}) Clicked {count()}
`

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

export default defineConfig({ db: new Database({ url: process.env.DATABASE_URL, tables: [Member] }) })
`

// Each file inserts the same member: in one shared database the second would meet the first's row and fail on the unique name.
const SHARED_ROW = `import { Database } from '@kaynooo/pg-orm'
import { expect, it } from 'bun:test'
import { Member } from '../pg-orm.config'

it('inserts its member', async () => {
  const db = new Database({ url: process.env.DATABASE_URL, tables: [Member] })

  await db.repo(Member).write.insertOne({ name: 'Ada' })
  expect(await db.repo(Member).read.findMany()).toHaveLength(1)
  await db.close()
})
`

// The runner's own DATABASE_URL would win over the project's `.env.test`.
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'DATABASE_URL'))

async function project(withBunfig: boolean): Promise<string> {
  const dir = resolve(await scratchDir('kay-test-command-'))

  await Bun.write(join(dir, 'kay.config.ts'), 'export default {}\n')
  await Bun.write(join(dir, 'src', 'routes', 'index.kay'), ROUTE)
  await Bun.write(join(dir, 'tests', 'sum.test.ts'), `import { expect, it } from 'bun:test'\nimport { add } from '../src/routes/index.kay'\n\nit('adds', () => { expect(add(1, 2)).toBe(3) })\n`)

  if (withBunfig)
    await Bun.write(join(dir, 'bunfig.toml'), '[test]\npreload = [ "kay/test/preload" ]\n')

  return dir
}

async function run(dir: string, command: string[]): Promise<{ code: number, report: string }> {
  const child = Bun.spawn(command, { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...env, KAY_ROOT: dir } })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { code, report: out + err }
}

async function kayTest(dir: string, args: string[] = []) {
  return run(dir, [process.execPath, CLI, 'test', ...args])
}

async function withDatabase(dir: string): Promise<void> {
  await Bun.write(join(dir, '.env.test'), 'DATABASE_URL=sqlite://data/test.db\n')
  await Bun.write(join(dir, 'pg-orm.config.ts'), CONFIG)
  await Bun.write(join(dir, 'migrations', '0001_member.sql'), MIGRATION)
  await Bun.write(join(dir, 'tests', 'one.test.ts'), SHARED_ROW)
  await Bun.write(join(dir, 'tests', 'two.test.ts'), SHARED_ROW)
}

describe('kay test', () => {
  it('runs the tests of a project that has no bunfig.toml, importing .kay files', async () => {
    const { code, report } = await kayTest(await project(false))

    expect(report).toContain('1 pass')
    expect(code).toBe(0)
  }, 60_000)

  it('runs once the preload a bunfig.toml lists too', async () => {
    const { code, report } = await kayTest(await project(true))

    expect(report).toContain('1 pass')
    expect(code).toBe(0)
  }, 60_000)

  it('gives each file a database of its own, with no flag written', async () => {
    const dir = await project(false)

    await withDatabase(dir)

    const { code, report } = await kayTest(dir, ['tests/one.test.ts', 'tests/two.test.ts'])

    expect(report).toContain('2 pass')
    expect(code).toBe(0)
  }, 60_000)

  it('refuses a plain bun test of a project with a test database, naming the way out', async () => {
    const dir = await project(true)

    await withDatabase(dir)

    const { code, report } = await run(dir, [process.execPath, 'test'])

    expect(report).toContain('run the tests as `kay test`, or `bun test --isolate`')
    expect(code).not.toBe(0)
  }, 60_000)

  it('does not refuse bun test --isolate or --parallel', async () => {
    const dir = await project(true)

    await withDatabase(dir)

    for (const flag of ['--isolate', '--parallel']) {
      const { code, report } = await run(dir, [process.execPath, 'test', flag, 'tests/one.test.ts', 'tests/two.test.ts'])

      expect(report).toContain('2 pass')
      expect(code).toBe(0)
    }
  }, 60_000)

  it('reports a failure at the line of the .kay file', async () => {
    const dir = await project(false)

    await Bun.write(join(dir, 'tests', 'boom.test.ts'), `import { it } from 'bun:test'\nimport { boom } from '../src/routes/index.kay'\n\nit('throws', () => { boom() })\n`)

    const { code, report } = await kayTest(dir, ['tests/boom.test.ts'])

    expect(report).toContain('kaboom')
    expect(report).toMatch(/at boom \(\S+src\/routes\/index\.kay:6:/)
    expect(code).not.toBe(0)
  }, 60_000)

  it('passes the arguments on to bun test and answers its exit code', async () => {
    const dir = await project(false)

    await Bun.write(join(dir, 'tests', 'other.test.ts'), `import { expect, it } from 'bun:test'\n\nit('fails', () => { expect(1).toBe(2) })\n`)

    const only = await kayTest(dir, ['sum'])
    const all = await kayTest(dir, ['-t', 'adds'])

    expect(only.code).toBe(0)
    expect(only.report).toContain('1 pass')
    expect(all.report).toContain('1 pass')
    expect(all.code).toBe(0)
  }, 60_000)

  it('mounts a component with no DOM preload, loading happy-dom on the first mount only', async () => {
    const dir = await project(false)

    await Bun.write(join(dir, 'src', 'components', 'counter.kay'), COUNTER)
    await Bun.write(join(dir, 'tests', 'plain.test.ts'), `import { expect, it } from 'bun:test'\n\nit('has no document yet', () => { expect(typeof document).toBe('undefined') })\n`)
    await Bun.write(join(dir, 'tests', 'mount.test.ts'), `import { expect, it } from 'bun:test'\nimport { mountComponent, settle } from 'kay/test'\n\nit('mounts', async () => {\n  const { root, unmount } = await mountComponent('src/components/counter.kay')\n\n  root.querySelector('button')!.click()\n  await settle()\n  expect(root.textContent).toContain('1')\n  unmount()\n})\n`)

    const { code, report } = await kayTest(dir, ['tests/plain.test.ts', 'tests/mount.test.ts'])

    expect(report).toContain('2 pass')
    expect(code).toBe(0)
  }, 60_000)
})
