import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { outputDir } from '../src/build/assets'
import { kayBuild } from './check-helper'
import { scratchDir } from './scratch'

// An `await` block on a prerendered page resolves at build, so its pending content never reaches a visitor: the build says so, and names a page that spent its render waiting.
const CONFIG = 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ log: false })\n'
const TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
  include: ['src', '.kay/types'],
})
const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map(async root => rm(root, { recursive: true, force: true })))
})

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('prerender-await-')

  roots.push(root)
  await Promise.all(Object.entries({ 'tsconfig.json': TSCONFIG, 'kay.config.ts': CONFIG, ...files }).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

const slow = (ms: number) => `const value = new Promise<string>(resolve => setTimeout(resolve, ${ms}, 'ready'))`
const PAGE = (head: string, body: string) => `---\n${head}\n---\n${body}`
const AWAIT = 'await value\n  p loading\nthen text\n  p {text}\n'
const PENDING = 'p before\nawait value\n  p loading\nthen text\n  p {text}\n'
const NO_PENDING = 'await value\nthen text\n  p {text}\n'

describe('the build and the await blocks of a prerendered page', () => {
  it('warns of a block with a pending branch, naming the page, the file and the line', async () => {
    const root = await project({ 'src/routes/index.kay': PAGE(slow(1), PENDING) })
    const { code, report, output } = await kayBuild([root, '--no-check'])

    expect(code, `${report}${output}`).toBe(0)
    expect(`${report}${output}`).toMatch(/\/ renders an `await` block with a pending branch at src\/routes\/index\.kay:5[^\n]*client island[^\n]*deferred server island/)
    expect(await Bun.file(join(outputDir(root), 'pages/index.html')).text()).toContain('<p>ready</p>')
  }, 120_000)

  it('names the block of a component the page renders', async () => {
    const root = await project({
      'src/components/Late.kay': PAGE(slow(1), AWAIT),
      'src/routes/index.kay': PAGE('import Late from \'../components/Late.kay\'', 'Late'),
    })
    const { code, report, output } = await kayBuild([root, '--no-check'])

    expect(code, `${report}${output}`).toBe(0)
    expect(`${report}${output}`).toContain('src/components/Late.kay:4')
  }, 120_000)

  it('says nothing of a block with no pending branch', async () => {
    const root = await project({ 'src/routes/index.kay': PAGE(slow(1), NO_PENDING) })
    const { code, report, output } = await kayBuild([root, '--no-check'])

    expect(code, `${report}${output}`).toBe(0)
    expect(`${report}${output}`).not.toContain('`await` block')
  }, 120_000)

  it('says nothing of a block inside a client island', async () => {
    const root = await project({
      'src/components/Late.kay': PAGE(slow(1), `${AWAIT}button(onClick={() => {}}) more\n`),
      'src/routes/index.kay': PAGE('import Late from \'../components/Late.kay\'', 'Late'),
    })
    const { code, report, output } = await kayBuild([root, '--no-check'])

    expect(code, `${report}${output}`).toBe(0)
    expect(`${report}${output}`).not.toContain('`await` block')
  }, 120_000)

  for (const mode of ['defer', 'true']) {
    it(`says nothing of a block inside a server island marked ${mode}`, async () => {
      const root = await project({
        'src/components/Late.kay': PAGE(slow(1), AWAIT),
        'src/routes/index.kay': PAGE('import Late from \'../components/Late.kay\'', mode === 'true' ? 'Late(server)' : 'Late(server="defer")'),
      })
      const { code, report, output } = await kayBuild([root, '--no-check'])

      expect(code, `${report}${output}`).toBe(0)
      expect(`${report}${output}`).not.toContain('`await` block')
    }, 120_000)
  }

  it('says nothing of a page rendered per request', async () => {
    const root = await project({ 'src/routes/index.kay': `---\n${slow(1)}\n---\n--- server\nexport const page = { prerender: false }\n---\n${PENDING}` })
    const { code, report, output } = await kayBuild([root, '--no-check'])

    expect(code, `${report}${output}`).toBe(0)
    expect(`${report}${output}`).not.toContain('`await` block')
  }, 120_000)

  it('names a page that spent its render waiting, with the block it waited on', async () => {
    const root = await project({ 'src/routes/index.kay': PAGE(slow(1300), NO_PENDING) })
    const { code, report, output } = await kayBuild([root, '--no-check'])

    expect(code, `${report}${output}`).toBe(0)
    expect(`${report}${output}`).toMatch(/\/ waited [\d.]+s on an `await` block at src\/routes\/index\.kay:4/)
  }, 120_000)

  it('does not name a page that rendered fast', async () => {
    const root = await project({ 'src/routes/index.kay': PAGE(slow(1), NO_PENDING) })
    const { report, output } = await kayBuild([root, '--no-check'])

    expect(`${report}${output}`).not.toContain('waited')
  }, 120_000)
})
