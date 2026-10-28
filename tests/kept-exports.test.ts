import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { KEPT_EXPORTS, keptExports } from '../scripts/kept-exports'
import { CONTENT_EXPORTS, I18N_EXPORTS, IMAGE_EXPORTS, KAY_EXPORTS } from '../src/server/kept-exports'
import { keptScan } from '../src/server/pure-page'
import { scratchDir } from './scratch'

describe('the class a kept page gives each export of kay', () => {
  const roots: string[] = []

  afterAll(async () => {
    await Promise.all(roots.map(async root => rm(root, { recursive: true, force: true })))
  })

  it('is declared by a `// kept:` line above every export of kay, kay/content, kay/image and kay/i18n', () => {
    expect(keptExports().problems).toEqual([])
  })

  it('is the map bun scripts/kept-exports.ts writes from those lines', async () => {
    expect(await Bun.file(join(import.meta.dir, '..', KEPT_EXPORTS)).text(), 'run `bun scripts/kept-exports.ts`').toBe(keptExports().text)
  })

  it('names every value each entry exports, and nothing else', async () => {
    const names = async (module: Promise<object>) => Object.keys(await module).sort()

    expect(Object.keys(KAY_EXPORTS).sort()).toEqual(await names(import('../src/runtime')))
    expect(Object.keys(CONTENT_EXPORTS).sort()).toEqual(await names(import('../src/content')))
    expect(Object.keys(IMAGE_EXPORTS).sort()).toEqual(await names(import('../src/runtime/image.public')))
    expect(Object.keys(I18N_EXPORTS).sort()).toEqual(await names(import('../src/runtime/i18n.server')))
  })

  it('keeps a page formatting bytes, a duration or in the site\'s zone, and not one reading the clock', async () => {
    const root = await scratchDir('kept-exports-')
    const pages = { formatBytes: '(2048)', formatDuration: '(90_000)', timeZone: '()', formatRelativeTime: '(-3_600_000)', relativeTime: '(() => 0)()' }

    roots.push(root)
    await Promise.all(Object.entries(pages).map(async ([name, call]) => Bun.write(join(root, `src/routes/${name}.kay`), `--- server\nimport { ${name} } from 'kay/i18n'\n---\np {${name}${call}}\n`)))

    const at = async (name: string) => (await keptScan({ file: join(root, `src/routes/${name}.kay`), layouts: [] })).stop

    for (const name of ['formatBytes', 'formatDuration', 'timeZone'])
      expect(await at(name)).toBeUndefined()

    for (const name of ['formatRelativeTime', 'relativeTime'])
      expect(await at(name)).toMatchObject({ why: `imports \`${name}\` from \`kay/i18n\`, which a request or the clock can change` })
  })
})
