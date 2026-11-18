import { describe, expect, it } from 'bun:test'
import { resolveConfig } from '../src/config-resolve'
import { invalidConfigValues, unknownConfigKeys } from '../src/config-shape'
import { localeSettings } from '../src/server/i18n'

describe('the keys of the config', () => {
  it('refuse defaultLocale, prefixDefault and domains, naming default and mode', () => {
    expect(unknownConfigKeys({ i18n: { locales: ['fr'], defaultLocale: 'fr', prefixDefault: true, domains: { fr: 'x.fr' } } })).toEqual(['`i18n.defaultLocale`, moved to `i18n.default`', '`i18n.prefixDefault`, moved to `i18n.mode: \'always\'`', '`i18n.domains`, moved to `i18n.mode: { domains }`'])
  })

  it('are loaded in the config of an extension as in the app\'s', async () => {
    const resolved = await resolveConfig({ extensions: [{ name: 'mine', config: { assets: { images: { remote: ['https://cdn.example.com'] } } } }, { name: 'bare' }] })

    expect(resolved.extensions?.[0]?.config).toEqual({ assets: { images: { remote: { hosts: ['https://cdn.example.com'] } } } })
    expect(resolved.extensions?.[1]).toEqual({ name: 'bare' })
  })

  it('are checked in their groups', () => {
    expect(unknownConfigKeys({ assets: { favicon: true, imges: {} }, ops: { observe: { loadBudgt: 1 } }, i18n: { locales: ['fr'], default: 'fr', mod: 'always' } })).toHaveLength(3)
    expect(invalidConfigValues({ i18n: { locales: ['fr'], default: 'fr', mode: 'sometimes' } })).toHaveLength(1)
    expect(invalidConfigValues({ i18n: { locales: ['fr'], default: 'en' } })).toHaveLength(1)
  })

  it('refuse the keys of before 1.105, naming where each lives now', () => {
    const found = unknownConfigKeys({ favicon: 'a.svg', health: false, onStart: () => undefined, env: false, offline: true, images: {} })

    expect(found).toEqual(['`favicon`, moved to `assets.favicon`', '`health`, moved to `ops.health`', '`onStart`, moved to `onListen`', '`env`, moved to `envFiles`', '`offline`, moved to `client.offline`', '`images`, moved to `assets.images`'])
    expect(unknownConfigKeys({ assets: { images: { remoteMaxSize: '1mb', quality: 70 } }, serve: { apiPrefix: '/v1' }, mcp: { key: 'a' }, openapi: { referencePath: '/docs' }, ops: { health: { path: '/up' }, observe: { onError: () => undefined } } })).toHaveLength(7)
  })

  it('refuse a proxy count and a proxy key written as a header name', () => {
    expect(invalidConfigValues({ proxy: 2 })).toHaveLength(1)
    expect(invalidConfigValues({ proxy: { key: 'x-up' } })).toHaveLength(1)
    expect(invalidConfigValues({ proxy: { hops: 2, key: { header: 'x-up' } }, ops: { observe: { log: 'json' } } })).toHaveLength(1)
  })
})

describe('the locale settings', () => {
  it('take mode as the prefix of the default locale or as domains', () => {
    expect(localeSettings({ locales: ['fr', 'en'], default: 'fr' })).toMatchObject({ prefixDefault: false })
    expect(localeSettings({ locales: ['fr', 'en'], default: 'fr', mode: 'always' })).toMatchObject({ prefixDefault: true })
    expect(localeSettings({ locales: ['fr', 'en'], default: 'fr', mode: { domains: { fr: 'x.fr', en: 'x.com' } } }).hosts).toEqual({ fr: 'x.fr', en: 'x.com' })
  })
})
