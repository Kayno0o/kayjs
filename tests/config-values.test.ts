import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { loadConfig } from '../src/config-loader'
import { problem } from '../src/config-rules'
import { invalidConfigValues, unknownConfigKeys } from '../src/config-shape'
import { scratchDir } from './scratch'

async function load(config: string): Promise<unknown> {
  const root = await scratchDir('config-values-')

  await Bun.write(join(root, 'kay.config.ts'), config)

  try {
    return await loadConfig(root)
  }
  catch (error) {
    return error
  }
}

describe('config values checked once at load', () => {
  it('accepts a guard, a list or { load } for each guard option', () => {
    const guard = () => undefined

    expect(invalidConfigValues({ jobs: { guard: { load: () => guard } }, images: { guard: [guard, guard] } })).toEqual([])
    expect(invalidConfigValues({ images: { guard: { load: () => guard } }, jobs: { guard: [guard] }, manifest: { themeColor: { light: '#fff', dark: '#000' } }, live: { rate: { max: 1, window: '1m' } } })).toEqual([])
    expect(invalidConfigValues({ images: { guard: 'no' } })).toHaveLength(1)
  })

  it('accepts Infinity where it is documented, reads it back in a message, and shortens or hides what it prints', () => {
    expect(invalidConfigValues({ images: { maxDensity: Infinity } })).toEqual([])
    expect(invalidConfigValues({ images: { maxDensity: NaN } })).toEqual(['`images.maxDensity` is NaN, expected a number'])
    expect(invalidConfigValues({ images: { quality: Infinity } })).toEqual(['`images.quality` is Infinity, expected a number'])
    expect(invalidConfigValues({ serve: { compress: 'x'.repeat(60) } })[0]).toBe(`\`serve.compress\` is "${'x'.repeat(40)}...", expected true or false`)
    expect(problem('auth.sessionSecret', 'hunter2', 'a number')).toBe('`auth.sessionSecret` is a string, expected a number')
    expect(problem('proxy.key', 'abc', 'a number')).toBe('`proxy.key` is a string, expected a number')
  })

  it('names the key path, the allowed values and the nearest match for a value that is not one of them', () => {
    expect(invalidConfigValues({ trailingSlash: 'sometimes' })).toEqual(['`trailingSlash` is "sometimes", expected one of "never", "always" or "ignore"'])
    expect(invalidConfigValues({ trailingSlash: 'alway' })).toEqual(['`trailingSlash` is "alway", expected one of "never", "always" or "ignore"; did you mean "always"?'])
    expect(invalidConfigValues({ security: { cookies: { sameSite: 'Strict' } } })).toEqual(['`security.cookies.sameSite` is "Strict", expected one of "lax", "strict" or "none"; did you mean "strict"?'])
  })

  it('reports the kind of a value that is not the kind of its key, the path through bags, lists and maps', () => {
    expect(invalidConfigValues({ lang: 5, base: true, serve: { compress: 7, timeout: 30 }, images: { webp: { quality: '90' } }, fonts: ['x'], publicCache: { '/a/**': 5 }, i18n: { locales: ['en', 3], defaultLocale: 'en' } })).toEqual([
      '`lang` is 5, expected a string',
      '`base` is true, expected a string',
      '`serve.compress` is 7, expected true or false',
      '`serve.timeout` is 30, expected a duration such as \'250ms\', \'5m\' or \'30d\' or false',
      '`images.webp.quality` is "90", expected a number',
      '`fonts[0]` is "x", expected an object',
      '`publicCache./a/**` is 5, expected a duration such as \'250ms\', \'5m\' or \'30d\'',
      '`i18n.locales[1]` is 3, expected a string',
    ])
  })

  it('reports an object where a bag is, and the inner problem of the bag an object stands for', () => {
    expect(invalidConfigValues({ images: 'x', health: true, security: { cookies: { secure: 'yes' } }, proxy: { hops: 'one' } })).toEqual([
      '`images` is "x", expected an object of options',
      '`health` is true, expected false or an object of options',
      '`security.cookies.secure` is "yes", expected true or false or one of "auto"',
      '`proxy.hops` is "one", expected a number',
    ])
  })

  it('refuses a default locale outside the locales', () => {
    expect(invalidConfigValues({ i18n: { locales: ['en', 'fr'], defaultLocale: 'de' } })).toEqual(['`i18n.defaultLocale` is "de", expected one of its locales: "en", "fr"'])
    expect(invalidConfigValues({ i18n: { locales: ['en', 'fr'], defaultLocale: 'fr' } })).toEqual([])
  })

  it('leaves a key set to undefined, the shapes the types take and the keys another check owns alone', () => {
    expect(invalidConfigValues({ lang: undefined, offline: true, health: false, security: false, robots: false, client: { prefetch: false }, favicon: false, secret: ['a', 'b'], proxy: true, metrics: true, limits: { body: 1024 }, serve: { timeout: false, shutdownTimeout: '5s' }, observe: { log: false }, checks: [], env: { compose: 'x' }, cors: { origins: '*' } })).toEqual([])
  })

  it('checks the keys of the bags 1.88 grouped', () => {
    expect(invalidConfigValues({ serve: { compress: 'yes' }, limits: { body: 'big' } })).toEqual(['`serve.compress` is "yes", expected true or false', '`limits.body` is "big", expected a size such as 4096 or \'20kb\''])
  })

  it('finds a mistyped key in every option bag, with the nearest one', () => {
    expect(unknownConfigKeys({ images: { qualty: 80, webp: { qualty: 1 } }, markdown: { headinLinks: true }, jobs: { gard: () => undefined }, live: { connection: 1 }, links: { outsde: 'new-tab' }, cors: { origin: '*' }, client: { hydration: { visble: 'x' } }, budget: { weigth: 1 }, manifest: { shortname: 'x' }, robots: { dissallow: [] }, preview: { secrt: 'x' }, metrics: { pth: '/m' }, runtimeRedirects: { host: [] }, sitemap: { tll: '1h' } })).toEqual([
      '`images.qualty`, did you mean `images.quality`?',
      '`images.webp.qualty`, did you mean `images.webp.quality`?',
      '`markdown.headinLinks`, did you mean `markdown.headingLinks`?',
      '`jobs.gard`, did you mean `jobs.guard`?',
      '`live.connection`, did you mean `live.connections`?',
      '`links.outsde`, did you mean `links.outside`?',
      '`cors.origin`, did you mean `cors.origins`?',
      '`client.hydration.visble`, did you mean `client.hydration.visible`?',
      '`budget.weigth`, did you mean `budget.weight`?',
      '`manifest.shortname`, did you mean `manifest.shortName`?',
      '`robots.dissallow`, did you mean `robots.disallow`?',
      '`preview.secrt`, did you mean `preview.secret`?',
      '`metrics.pth`, did you mean `metrics.path`?',
      '`runtimeRedirects.host`, did you mean `runtimeRedirects.hosts`?',
      '`sitemap.tll`, did you mean `sitemap.ttl`?',
    ])
  })

  it('refuses, at load, the values the types would have refused, as config-invalid and never a TypeError', async () => {
    const trailing = await load('export default { trailingSlash: \'sometimes\', base: \'blog\', serve: { compress: 7 } } as never\n')
    const lang = await load('export default { lang: 5 } as never\n')
    const locale = await load('export default { i18n: { locales: [\'en\'], defaultLocale: \'fr\' } }\n')
    const fine = await load('export default { lang: \'en\', trailingSlash: \'always\', serve: { compress: false } }\n')

    expect(trailing).toMatchObject({ code: 'config-invalid' })
    expect(String(trailing)).toContain('`trailingSlash` is "sometimes"')
    expect(String(trailing)).toContain('`serve.compress` is 7')
    expect(lang).toMatchObject({ code: 'config-invalid' })
    expect(String(lang)).toContain('`lang` is 5, expected a string')
    expect(String(locale)).toContain('`i18n.defaultLocale` is "fr"')
    expect(fine).toMatchObject({ lang: 'en', trailingSlash: 'always' })
  })

  it('checks an extension\'s config the same way', async () => {
    const error = await load('export default { extensions: [{ name: \'lib\', config: { lang: 5 } }] } as never\n')

    expect(String(error)).toContain('the config of the extension lib has a value of the wrong kind: `lang` is 5')
  })
})
