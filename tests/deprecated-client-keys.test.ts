import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { clientKeys } from '../src/check/client-keys'
import { applySafeFixes } from '../src/check/fixes'
import { resolveConfig } from '../src/config-resolve'
import { invalidConfigValues, unknownConfigKeys } from '../src/config-shape'
import { scratchDir } from './scratch'

async function fixed(files: Record<string, string>): Promise<{ text: Record<string, string>, found: Awaited<ReturnType<typeof clientKeys>> }> {
  const root = await scratchDir('client-keys-')

  try {
    await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

    const found = await clientKeys(root, {})

    await applySafeFixes(root, found)

    return { found, text: Object.fromEntries(await Promise.all(Object.keys(files).map(async path => [path, await Bun.file(join(root, path)).text()]))) }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('deprecated-client-keys', () => {
  it('moves links, offline and search into client and keeps the others', async () => {
    const { found, text } = await fixed({
      'kay.config.ts': 'export default { lang: \'en\', search: true, links: { outside: \'same-tab\' }, minify: false, offline: { pages: [\'/\'] } }\n',
    })

    expect(found).toHaveLength(3)
    expect(text['kay.config.ts']).toBe('export default { lang: \'en\', client: { search: true, links: { outside: \'same-tab\' }, offline: { pages: [\'/\'] } }, minify: false }\n')
  })

  it('takes a shorthand key and a method beside it, and the config handed to pages()', async () => {
    const { text } = await fixed({
      'kay.config.ts': 'const search = true\nexport default { search, onListen() {} }\n',
      'src/app.ts': 'import { pages } from \'kay/server\'\n\nawait pages({ root: \'.\', config: { offline: true } })\n',
    })

    expect(text['kay.config.ts']).toBe('const search = true\nexport default { client: { search }, onListen() {} }\n')
    expect(text['src/app.ts']).toContain('config: { client: { offline: true } }')
  })

  it('reports with no fix where client is already written or the object spreads', async () => {
    const { found, text } = await fixed({
      'kay.config.ts': 'export default { client: { prefetch: false }, search: true }\n',
      'a/kay.config.ts': 'import base from \'./base\'\nexport default { ...base, search: true }\n',
    })

    expect(found).toHaveLength(2)
    expect(found.every(one => one.fixes === undefined)).toBe(true)
    expect(text['kay.config.ts']).toContain('search: true')
  })

  it('leaves the grouped form, other files and the keys of other bags alone', async () => {
    const { found } = await fixed({
      'kay.config.ts': 'export default { client: { search: true, links: { outside: \'same-tab\' } }, robots: { allow: [] }, seo: { name: \'x\' } }\n',
      'src/other.ts': 'export default { search: true }\n',
    })

    expect(found).toEqual([])
  })
})

describe('the old keys of the config', () => {
  it('are read as client keys, the one written in client winning', async () => {
    expect(await resolveConfig({ search: true, offline: true, links: { outside: 'same-tab' }, client: { offline: false, prefetch: false } })).toEqual({ client: { search: true, offline: false, links: { outside: 'same-tab' }, prefetch: false } })
    expect(await resolveConfig({ lang: 'en' })).toEqual({ lang: 'en' })
  })

  it('are checked in client, and the old place still is', () => {
    expect(unknownConfigKeys({ client: { search: true, links: { outsde: 'x' } }, offline: true })).toEqual(['`client.links.outsde`, did you mean `client.links.outside`?'])
    expect(invalidConfigValues({ client: { search: 'yes' }, search: 'yes' })).toHaveLength(2)
  })
})
