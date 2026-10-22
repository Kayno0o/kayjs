import { join, resolve } from 'node:path'
import { expect, it } from 'bun:test'
import { clientDir } from '../src/build/assets'
import { PRODUCTION, resolveProject } from '../src/project'
import { servePages } from '../src/server/app'
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

async function app(extra: Record<string, string> = {}): Promise<string> {
  const dir = resolve(await scratchDir('test-site-broken-route-'))

  await Bun.write(join(dir, 'kay.config.ts'), 'export default {}\n')
  await Bun.write(join(dir, 'src', 'routes', 'index.kay'), `---\nimport Counter from '../components/counter.kay'\n---\nh1 Home\nCounter\n`)
  await Bun.write(join(dir, 'src', 'components', 'counter.kay'), ISLAND)
  await Bun.write(join(dir, 'src', 'routes', 'broken.kay'), BROKEN)
  await Bun.write(join(dir, 'tests', 'home.test.ts'), VISIT('/'))
  await Bun.write(join(dir, 'tests', 'broken.test.ts'), VISIT('/broken'))

  for (const [file, source] of Object.entries(extra))
    await Bun.write(join(dir, file), source)

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
  expect(report).not.toMatch(/\n\s*at (?!<anonymous>)/)
  expect(report.split('\n').length).toBeLessThan(60)
}, 120_000)

it('fails only the pages using a broken layout or component', async () => {
  const dir = await app({
    'src/routes/guarded/_layout.kay': BROKEN,
    'src/routes/guarded/index.kay': 'h1 Guarded\n',
    'src/components/bad.kay': BROKEN,
    'src/routes/uses-bad.kay': '---\nimport Bad from \'../components/bad.kay\'\n---\nBad\n',
    'tests/guarded.test.ts': VISIT('/guarded'),
    'tests/uses-bad.test.ts': VISIT('/uses-bad'),
  })
  const { code, report } = await kayTest(dir, ['tests/home.test.ts', 'tests/guarded.test.ts', 'tests/uses-bad.test.ts'])

  expect(report).toContain('1 pass')
  expect(report).toContain('2 fail')
  expect(report).toContain('_layout.kay')
  expect(report).toContain('bad.kay')
  expect(code).not.toBe(0)
}, 120_000)

it('still throws the build error of a site loaded in a browser', async () => {
  const dir = await app({ 'tests/browser.test.ts': 'import { testSite } from \'kay/test\'\n\nawait testSite({ browser: true })\n' })
  const { code, report } = await kayTest(dir, ['tests/browser.test.ts'])

  expect(code).not.toBe(0)
  expect(report).toContain('broken.kay')
}, 120_000)

it('still fails the boot of a site on an error that is no compile error', async () => {
  const dir = await app({ 'src/routes/missing.kay': '---\nimport nothing from \'./nothing-here\'\n---\nh1 {String(nothing)}\n' })
  const { code, report } = await kayTest(dir, ['tests/home.test.ts'])

  expect(code).not.toBe(0)
  expect(report).toContain('nothing-here')
}, 120_000)

it('serves no page of a project with a route that does not compile unless asked to skip it', async () => {
  const dir = resolve(await scratchDir('test-site-broken-default-'))

  await Bun.write(join(dir, 'src', 'routes', 'broken.kay'), BROKEN)
  await Bun.write(join(dir, 'kay.config.ts'), 'export default {}\n')

  const project = resolveProject(dir, { dev: false, prebuilt: false }, PRODUCTION)
  const client = { entryImports: [], islands: {}, styles: new Map(), pages: new Map(), dir: clientDir(dir) }

  await expect(servePages(project, () => client)).rejects.toThrow('broken.kay')
})
