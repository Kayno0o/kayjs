import { join, resolve } from 'node:path'
import { expect, it } from 'bun:test'
import { scratchDir } from './scratch'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'DATABASE_URL'))

// The second fence is never closed, so the route does not compile.
const BROKEN = `---
const a = 1
h1 Broken
`

const ISLAND = `---
import { signal } from 'kay'

const count = signal(0)
---
button(onClick={() => count.set(n => n + 1)}) Clicked {count()}
`

const VISIT = (path: string) => `import { expect, it } from 'bun:test'\nimport { testSite } from 'kay/test'\n\nconst site = await testSite()\n\nit('visits', async () => { expect((await site.visit(${JSON.stringify(path)})).status).toBe(200) })\n`

async function app(): Promise<string> {
  const dir = resolve(await scratchDir('test-site-broken-route-'))

  await Bun.write(join(dir, 'kay.config.ts'), 'export default {}\n')
  await Bun.write(join(dir, 'src', 'routes', 'index.kay'), `---\nimport Counter from '../components/counter.kay'\n---\nh1 Home\nCounter\n`)
  await Bun.write(join(dir, 'src', 'components', 'counter.kay'), ISLAND)
  await Bun.write(join(dir, 'src', 'routes', 'broken.kay'), BROKEN)
  await Bun.write(join(dir, 'tests', 'home.test.ts'), VISIT('/'))
  await Bun.write(join(dir, 'tests', 'broken.test.ts'), VISIT('/broken'))

  return dir
}

async function kayTest(dir: string, args: string[]): Promise<{ code: number, report: string }> {
  const child = Bun.spawn([process.execPath, CLI, 'test', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...env, KAY_ROOT: dir } })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { code, report: out + err }
}

it('keeps the tests of other pages green when one route does not compile', async () => {
  const { code, report } = await kayTest(await app(), ['tests/home.test.ts'])

  expect(report).toContain('1 pass')
  expect(code).toBe(0)
}, 120_000)

it('fails the test of the broken route with a message naming its file', async () => {
  const { code, report } = await kayTest(await app(), ['tests/broken.test.ts'])

  expect(code).not.toBe(0)
  expect(report).toContain('broken.kay')
  expect(report).not.toMatch(/\n {4}at (?!<anonymous>)/)
  expect(report.split('\n').length).toBeLessThan(60)
}, 120_000)
