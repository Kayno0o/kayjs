import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { outputDir } from '../src/build/assets'
import { kayBuild } from './check-helper'
import { scratchDir } from './scratch'

// The pages of a route render several at once, each finishing in the reverse of its order: what the build says of each page is still its own, and a failure is the first in order.
const CONFIG = 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ log: false })\n'
const TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
  include: ['src', '.kay/types'],
})
// Each page waits longer than the next, so the last listed finishes first.
const WAIT = 'await new Promise(resolve => setTimeout(resolve, 10 * (5 - [\'a\', \'b\', \'c\', \'d\', \'e\'].indexOf(ctx.params.id))))\n'
const LISTED = 'export const page = { prerender: [\'a\', \'b\', \'c\', \'d\', \'e\'].map(id => ({ id })) }\n'

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map(async root => rm(root, { recursive: true, force: true })))
})

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('at-once-')

  roots.push(root)
  await Promise.all(Object.entries({ 'tsconfig.json': TSCONFIG, 'kay.config.ts': CONFIG, ...files }).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('prerendering the listed pages of a route at once', () => {
  it('marks only the page that read the stand-in site, though the others rendered beside it', async () => {
    const root = await project({ 'src/routes/[id].kay': `--- server\nimport { siteOrigin } from 'kay/seo'\n\n${LISTED}\n${WAIT}const id = ctx.params.id\nconst origin = id === 'b' ? siteOrigin() : ''\n---\np {id} {origin}\n` })
    const { code, report, output } = await kayBuild([root, '--no-check'])

    expect(code, `${report}${output}`).toBe(0)

    const { pages } = await Bun.file(join(outputDir(root), 'manifest.json')).json() as { pages: Record<string, { readsSite?: boolean, token?: string }> }

    expect(Object.keys(pages).sort()).toEqual(['/a', '/b', '/c', '/d', '/e'])
    expect(Object.entries(pages).filter(([, page]) => page.readsSite === true).map(([path]) => path)).toEqual(['/b'])
    expect(await Bun.file(join(outputDir(root), 'pages/e.html')).text()).toContain('<p>e </p>')
  }, 120_000)

  it('renders no more than 8 of them at once', async () => {
    const ids = Array.from({ length: 12 }, (_, index) => `p${index}`)
    const root = await project({
      'src/running.ts': 'export const running = { now: 0, most: 0 }\n',
      'src/routes/[id].kay': `--- server\nimport { running } from '../running'\n\nexport const page = { prerender: ${JSON.stringify(ids)}.map(id => ({ id })) }\n\nrunning.now++\nrunning.most = Math.max(running.most, running.now)\nawait new Promise(resolve => setTimeout(resolve, 30))\nrunning.now--\nconst most = running.most\n---\np {most}\n`,
    })
    const { code, report, output } = await kayBuild([root, '--no-check'])

    expect(code, `${report}${output}`).toBe(0)
    expect(await Bun.file(join(outputDir(root), 'pages/p11.html')).text()).toContain('<p>8</p>')
  }, 120_000)

  it('fails the build on the first page in order that fails, not the first to finish', async () => {
    const root = await project({ 'src/routes/[id].kay': `--- server\n${LISTED}\n${WAIT}if (ctx.params.id === 'b' || ctx.params.id === 'd')\n  throw new Error(\`broken \${ctx.params.id}\`)\nconst id = ctx.params.id\n---\np {id}\n` })
    const { code, report, output } = await kayBuild([root, '--no-check'])

    expect(code).not.toBe(0)
    expect(`${report}${output}`).toContain('prerendering /b from src/routes/[id].kay failed with 500')
    expect(`${report}${output}`).not.toContain('prerendering /d from')
  }, 120_000)
})
