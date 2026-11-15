import type { CheckDiagnostic, CheckOptions } from '../src/check'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { pagesOptions } from '../src/check/pages-options'
import { scratchDir } from './scratch'

const check: (root: string, options: CheckOptions) => Promise<CheckDiagnostic[]> = pagesOptions

async function fixed(files: Record<string, string>): Promise<{ text: Record<string, string>, found: CheckDiagnostic[] }> {
  const root = await scratchDir('pages-options-')

  try {
    await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

    const found = await check(root, {})

    await applySafeFixes(root, found)

    return { found, text: Object.fromEntries(await Promise.all(Object.keys(files).map(async path => [path, await Bun.file(join(root, path)).text()]))) }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('deprecated-pages-options', () => {
  it('moves the config keys of pages() into config and keeps the options of the call', async () => {
    const { found, text } = await fixed({
      'src/server.ts': 'import { pages } from \'kay/server\'\n\nexport default pages({ root: import.meta.dir, client: { navigation: false }, dev: true, minify: false })\n',
    })

    expect(found).toHaveLength(2)
    expect(text['src/server.ts']).toBe('import { pages } from \'kay/server\'\n\nexport default pages({ root: import.meta.dir, config: { client: { navigation: false }, minify: false }, dev: true })\n')
  })

  it('knows the options of a test site', async () => {
    const { found, text } = await fixed({
      'tests/a.test.ts': 'import { testSite } from \'kay/test\'\n\nconst site = await testSite({ root: \'x\', browser: true, headers: {}, observe: { log: false }, mcpKey: \'k\', store: { files: f } })\n',
    })

    expect(found).toHaveLength(2)
    expect(text['tests/a.test.ts']).toContain('testSite({ root: \'x\', browser: true, headers: {}, config: { observe: { log: false }, store: { files: f } }, mcpKey: \'k\' })')
  })

  it('moves a shorthand key and reports with no fix where the options spread or hold a config', async () => {
    const { found, text } = await fixed({
      'a.ts': 'import { pages } from \'kay/server\'\n\npages({ lang, root: \'x\' })\n',
      'b.ts': 'import { pages } from \'kay/server\'\n\npages({ ...base, lang: \'en\' })\n',
      'c.ts': 'import { pages } from \'kay/server\'\n\npages({ lang: \'en\', config: { site: \'x\' } })\n',
    })

    expect(found).toHaveLength(3)
    expect(text['a.ts']).toContain('pages({ config: { lang }, root: \'x\' })')
    expect(text['b.ts']).toContain('...base')
    expect(found.filter(one => one.fixes === undefined)).toHaveLength(2)
  })

  it('leaves config, other calls and other files alone', async () => {
    const { found } = await fixed({
      'a.ts': 'import { pages } from \'kay/server\'\n\npages({ root: \'x\', config: { lang: \'en\' } })\n',
      'b.ts': 'import { pages } from \'./pages\'\n\npages({ lang: \'en\' })\n',
      'kay.config.ts': 'export default { lang: \'en\' }\n',
    })

    expect(found).toEqual([])
  })
})
