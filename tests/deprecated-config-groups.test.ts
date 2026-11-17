import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { configGroups } from '../src/check/config-groups'
import { applySafeFixes } from '../src/check/fixes'
import { i18nKeys } from '../src/check/i18n-keys'
import { withConfig } from '../src/config-loader'
import { resolveConfig } from '../src/config-resolve'
import { invalidConfigValues, unknownConfigKeys } from '../src/config-shape'
import { localeSettings } from '../src/server/i18n'
import { scratchDir } from './scratch'

type Lint = typeof configGroups

async function fixed(lint: Lint, files: Record<string, string>): Promise<{ text: Record<string, string>, found: Awaited<ReturnType<Lint>> }> {
  const root = await scratchDir('config-groups-')

  try {
    await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

    const found = await lint(root, {})

    await applySafeFixes(root, found)

    return { found, text: Object.fromEntries(await Promise.all(Object.keys(files).map(async path => [path, await Bun.file(join(root, path)).text()]))) }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('deprecated-config-groups', () => {
  it('moves the asset keys into assets and the operations keys into ops', async () => {
    const { found, text } = await fixed(configGroups, {
      'kay.config.ts': 'export default { lang: \'en\', favicon: \'a.svg\', health: false, images: { widths: [1] }, observe: { loadBudget: false }, minify: false }\n',
    })

    expect(found).toHaveLength(4)
    expect(text['kay.config.ts']).toContain('assets: { favicon: \'a.svg\', images: { widths: [1] } }')
    expect(text['kay.config.ts']).toContain('ops: { health: false, observe: { loadBudget: false } }')
    expect(text['kay.config.ts']).not.toMatch(/^export default \{[^}]*\bhealth: false, images/)
  })

  it('reports with no fix where the group is already written or the object spreads', async () => {
    const { found, text } = await fixed(configGroups, {
      'kay.config.ts': 'export default { assets: { fonts: [] }, favicon: true }\n',
      'a/kay.config.ts': 'import base from \'./base\'\nexport default { ...base, jobs: { path: \'/j\' } }\n',
    })

    expect(found).toHaveLength(2)
    expect(found.every(one => one.fixes === undefined)).toBe(true)
    expect(text['kay.config.ts']).toContain('favicon: true')
  })

  it('leaves the grouped form, other files and the keys of other bags alone', async () => {
    const { found } = await fixed(configGroups, {
      'kay.config.ts': 'export default { assets: { favicon: true }, ops: { health: false, metrics: true }, seo: { image: \'/x.png\' } }\n',
      'src/other.ts': 'export default { favicon: true }\n',
    })

    expect(found).toEqual([])
  })
})

describe('deprecated-i18n-keys', () => {
  it('renames defaultLocale and rewrites prefixDefault and domains', async () => {
    const { found, text } = await fixed(i18nKeys, {
      'kay.config.ts': 'export default { i18n: { locales: [\'fr\', \'en\'], defaultLocale: \'fr\', prefixDefault: true } }\n',
      'a/kay.config.ts': 'const domains = { fr: \'x.fr\', en: \'x.com\' }\nexport default { i18n: { locales: [\'fr\', \'en\'], defaultLocale: \'fr\', domains } }\n',
    })

    expect(found).toHaveLength(4)
    expect(text['kay.config.ts']).toBe('export default { i18n: { locales: [\'fr\', \'en\'], default: \'fr\', mode: \'always\' } }\n')
    expect(text['a/kay.config.ts']).toContain('default: \'fr\', mode: { domains } }')
  })

  it('offers no fix for domains with prefixDefault, a spread, or a mode already there', async () => {
    const { found } = await fixed(i18nKeys, {
      'kay.config.ts': 'export default { i18n: { locales: [\'fr\'], default: \'fr\', domains: { fr: \'x.fr\' }, prefixDefault: true } }\n',
      'a/kay.config.ts': 'export default { i18n: { ...base, defaultLocale: \'fr\' } }\n',
      'b/kay.config.ts': 'export default { i18n: { locales: [\'fr\'], default: \'fr\', mode: \'prefix\', prefixDefault: true } }\n',
    })

    expect(found).toHaveLength(4)
    expect(found.every(one => one.fixes === undefined)).toBe(true)
  })

  it('leaves the new form alone', async () => {
    const { found } = await fixed(i18nKeys, { 'kay.config.ts': 'export default { i18n: { locales: [\'fr\'], default: \'fr\', mode: { domains: { fr: \'x.fr\' } } } }\n' })

    expect(found).toEqual([])
  })
})

describe('the old keys of the config', () => {
  it('are read into assets and ops, the key written in the group winning', async () => {
    expect(await resolveConfig({ favicon: 'a.svg', health: false, metrics: true, assets: { favicon: 'b.svg' }, ops: { jobs: { guards: [] } } })).toEqual({ assets: { favicon: 'b.svg' }, ops: { health: false, metrics: true, jobs: { guards: [] } } })
    expect((await resolveConfig({ observe: { onError: () => undefined, loadBudget: false } })).ops).toEqual({ observe: { loadBudget: false } })
  })

  it('read defaultLocale, prefixDefault and domains as default and mode', async () => {
    expect((await resolveConfig({ i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', prefixDefault: true } })).i18n).toEqual({ locales: ['fr', 'en'], default: 'fr', mode: 'always' })
    expect((await resolveConfig({ i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', domains: { fr: 'x.fr', en: 'x.com' } } })).i18n).toEqual({ locales: ['fr', 'en'], default: 'fr', mode: { domains: { fr: 'x.fr', en: 'x.com' } } })
    expect((await resolveConfig({ i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', default: 'en' } })).i18n?.default).toBe('en')
    await expect(resolveConfig({ i18n: { locales: ['fr'], default: 'fr', prefixDefault: true, domains: { fr: 'x.fr' } } })).rejects.toThrow('domains or prefixDefault')
    expect((await resolveConfig({ i18n: { locales: ['fr'], default: 'fr', mode: 'always', prefixDefault: true, domains: { fr: 'x.fr' } } })).i18n?.mode).toBe('always')
  })

  it('are read in the config of an extension as in the app\'s', async () => {
    const resolved = await resolveConfig({ extensions: [{ name: 'mine', config: { favicon: 'a.svg', observe: { loadBudget: false }, metrics: true } }, { name: 'bare' }] })

    expect(resolved.extensions?.[0]?.config).toEqual({ assets: { favicon: 'a.svg' }, ops: { observe: { loadBudget: false }, metrics: true } })
    expect(resolved.extensions?.[1]).toEqual({ name: 'bare' })
  })

  it('are found and moved in the config of a KayExtension', async () => {
    const { found, text } = await fixed(configGroups, {
      'src/mine.ts': 'import type { KayExtension } from \'kay/server\'\n\nexport const mine: KayExtension = { name: \'mine\', config: { favicon: \'a.svg\', health: false } }\n',
      'src/other.ts': 'export const other = { name: \'x\', config: { favicon: \'a.svg\' } }\n',
    })

    expect(found).toHaveLength(2)
    expect(text['src/mine.ts']).toContain('config: { assets: { favicon: \'a.svg\' }, ops: { health: false } }')
    expect(text['src/other.ts']).toContain('config: { favicon: \'a.svg\' }')
  })

  it('are checked in their groups', () => {
    expect(unknownConfigKeys({ assets: { favicon: true, imges: {} }, ops: { observe: { loadBudgt: 1 } }, i18n: { locales: ['fr'], default: 'fr', mod: 'always' } })).toHaveLength(3)
    expect(invalidConfigValues({ i18n: { locales: ['fr'], default: 'fr', mode: 'sometimes' } })).toHaveLength(1)
    expect(invalidConfigValues({ i18n: { locales: ['fr'], default: 'en' } })).toHaveLength(1)
  })

  it('reach the loaded config of code options, whole', async () => {
    const config = await withConfig(resolve('tests/fixtures/static'), { favicon: false, jobs: { guards: [] } } as never)

    expect(config.assets?.favicon).toBe(false)
    expect(config.ops?.jobs).toEqual({ guards: [] })
    expect('favicon' in config).toBe(false)
  })
})

describe('the locale settings', () => {
  it('take mode as the prefix of the default locale or as domains', () => {
    expect(localeSettings({ locales: ['fr', 'en'], default: 'fr' })).toMatchObject({ prefixDefault: false })
    expect(localeSettings({ locales: ['fr', 'en'], default: 'fr', mode: 'always' })).toMatchObject({ prefixDefault: true })
    expect(localeSettings({ locales: ['fr', 'en'], default: 'fr', mode: { domains: { fr: 'x.fr', en: 'x.com' } } }).hosts).toEqual({ fr: 'x.fr', en: 'x.com' })
  })
})
