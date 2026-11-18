import { resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { withConfig } from '../src/config-loader'
import { resolveConfig } from '../src/config-resolve'

describe('config lists', () => {
  it('loads each list a function gives, awaiting a promise, and keeps one written out', async () => {
    const config = await resolveConfig({
      cors: { origins: async () => ['https://app.example.com'] },
      security: { hosts: () => ['example.com'] },
      proxy: { trusted: async () => ['173.245.48.0/20'], hops: 2 },
      robots: { disallow: () => ['/admin'], allow: ['/admin/help'] },
      redirects: async () => ({ '/old': '/new' }),
      i18n: { locales: ['en', 'fr'], default: 'en', paths: () => ({ '/about': { fr: '/a-propos' } }) },
      assets: { images: { remote: () => ['https://cms.example.com/'] } },
    })

    expect(config).toEqual({
      cors: { origins: ['https://app.example.com'] },
      security: { hosts: ['example.com'] },
      proxy: { trusted: ['173.245.48.0/20'], hops: 2 },
      robots: { disallow: ['/admin'], allow: ['/admin/help'] },
      redirects: { '/old': '/new' },
      i18n: { locales: ['en', 'fr'], default: 'en', paths: { '/about': { fr: '/a-propos' } } },
      assets: { images: { remote: { hosts: ['https://cms.example.com/'] } } },
    })
  })

  it('leaves a switch, a missing key and a list written out as they are', async () => {
    expect(await resolveConfig({ security: false, proxy: true, robots: true, cors: { origins: '*' }, assets: { images: { remote: { hosts: () => ['a'], timeout: '5s' } } } })).toEqual({ security: false, proxy: true, robots: true, cors: { origins: '*' }, assets: { images: { remote: { hosts: ['a'], timeout: '5s' } } } })
    expect(await resolveConfig({})).toEqual({})
    expect(await resolveConfig({ security: { hosts: true } })).toEqual({ security: { hosts: true } })
  })

  it('resolves the options of a code call as the file is, and a function too', async () => {
    const config = await withConfig(resolve('tests/fixtures/static'), { assets: { images: { limits: { variants: 3 }, remote: async () => ['https://cms.example.com/'] } }, security: { hosts: () => ['example.com'] } } as never) as { assets?: { images?: unknown }, security?: unknown }

    expect(config.assets?.images).toMatchObject({ limits: { variants: 3 }, remote: { hosts: ['https://cms.example.com/'] } })
    expect(config.security).toEqual({ hosts: ['example.com'] })
  })
})
