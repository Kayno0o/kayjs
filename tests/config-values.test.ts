import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { loadConfig, withConfig } from '../src/config-loader'
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

    expect(invalidConfigValues({ ops: { jobs: { guards: { load: () => guard } } }, assets: { images: { guards: [guard, guard] } } })).toEqual([])
    expect(invalidConfigValues({ assets: { images: { guards: { load: () => guard } }, manifest: { themeColor: { light: '#fff', dark: '#000' } } }, ops: { jobs: { guards: [guard] } }, live: { rate: { max: 1, window: '1m' } } })).toEqual([])
    expect(invalidConfigValues({ assets: { images: { guards: 'no' } } })).toHaveLength(1)
  })

  it('refuses a head entry whose text sits in `children` beside `props`, naming `props.children`', () => {
    expect(invalidConfigValues({ head: [{ tag: 'meta', props: {} }, { tag: 'script', props: {}, children: 'console.log(1)' }] })).toEqual(['`head[1].children` is ignored: a tag\'s text goes in `props.children`'])
    expect(invalidConfigValues({ head: [{ tag: 'script', props: { children: 'console.log(1)' } }] })).toEqual([])
  })

  it('accepts Infinity where it is documented, reads it back in a message, and shortens or hides what it prints', () => {
    expect(invalidConfigValues({ assets: { images: { maxDensity: Infinity } } })).toEqual([])
    expect(invalidConfigValues({ assets: { images: { maxDensity: NaN } } })).toEqual(['`assets.images.maxDensity` is NaN, expected a number'])
    expect(invalidConfigValues({ assets: { images: { formats: { quality: Infinity } } } })).toEqual(['`assets.images.formats.quality` is Infinity, expected a number'])
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
    expect(invalidConfigValues({ lang: 5, base: true, serve: { compress: 7, timeout: 30 }, assets: { images: { formats: { webp: { quality: '90' } } }, fonts: ['x'], publicCache: { '/a/**': 5 } }, i18n: { locales: ['en', 3], default: 'en' } })).toEqual([
      '`lang` is 5, expected a string',
      '`base` is true, expected a string',
      '`serve.compress` is 7, expected true or false',
      '`serve.timeout` is 30, expected a duration such as \'250ms\', \'5m\' or \'30d\' or false',
      '`assets.images.formats.webp.quality` is "90", expected a number',
      '`assets.fonts[0]` is "x", expected an object',
      '`assets.publicCache./a/**` is 5, expected a duration such as \'250ms\', \'5m\' or \'30d\'',
      '`i18n.locales[1]` is 3, expected a string',
    ])
  })

  it('reports an object where a bag is, and the inner problem of the bag an object stands for', () => {
    expect(invalidConfigValues({ assets: { images: 'x' }, ops: { health: 'x' }, security: { cookies: { secure: 'yes' } }, proxy: { hops: 'one' } })).toEqual([
      '`assets.images` is "x", expected an object of options',
      '`ops.health` is "x", expected true or false or an object of options',
      '`security.cookies.secure` is "yes", expected true or false or one of "auto"',
      '`proxy.hops` is "one", expected a number',
    ])
  })

  it('refuses a default locale outside the locales', () => {
    expect(invalidConfigValues({ i18n: { locales: ['en', 'fr'], default: 'de' } })).toEqual(['`i18n.default` is "de", expected one of its locales: "en", "fr"'])
    expect(invalidConfigValues({ i18n: { locales: ['en', 'fr'], default: 'fr' } })).toEqual([])
  })

  it('leaves a key set to undefined, the shapes the types take and the keys another check owns alone', () => {
    expect(invalidConfigValues({ lang: undefined, security: false, robots: false, client: { offline: true, prefetch: false }, assets: { favicon: false }, secret: ['a', 'b'], proxy: true, ops: { health: false, metrics: true, observe: { log: false } }, limits: { body: 1024 }, serve: { timeout: false, shutdownTimeout: '5s' }, checks: [], env: { compose: 'x' }, cors: { origins: '*' } })).toEqual([])
  })

  it('checks the keys of the bags 1.88 grouped', () => {
    expect(invalidConfigValues({ serve: { compress: 'yes' }, limits: { body: 'big' } })).toEqual(['`serve.compress` is "yes", expected true or false', '`limits.body` is "big", expected a size such as 4096 or \'20kb\''])
  })

  it('finds a mistyped key in every option bag, with the nearest one', () => {
    expect(unknownConfigKeys({ assets: { images: { formats: { qualty: 80, webp: { qualty: 1 } } }, manifest: { shortname: 'x' } }, markdown: { headinLinks: true }, ops: { jobs: { gard: () => undefined }, metrics: { tokn: 'x' } }, live: { connection: 1 }, cors: { origin: '*' }, client: { hydration: { visble: 'x' }, links: { outsde: 'new-tab' } }, budget: { weigth: 1 }, robots: { dissallow: [] }, preview: { secrt: 'x' }, runtimeRedirects: { host: [] }, sitemap: { tll: '1h' } })).toEqual([
      '`assets.images.formats.qualty`, did you mean `assets.images.formats.quality`?',
      '`assets.images.formats.webp.qualty`, did you mean `assets.images.formats.webp.quality`?',
      '`assets.manifest.shortname`, did you mean `assets.manifest.shortName`?',
      '`markdown.headinLinks`, did you mean `markdown.headingLinks`?',
      '`ops.jobs.gard`, did you mean `ops.jobs.guards`?',
      '`ops.metrics.tokn`, did you mean `ops.metrics.token`?',
      '`live.connection`, did you mean `live.connections`?',
      '`cors.origin`, did you mean `cors.origins`?',
      '`client.hydration.visble`, did you mean `client.hydration.visible`?',
      '`client.links.outsde`, did you mean `client.links.outside`?',
      '`budget.weigth`, did you mean `budget.weight`?',
      '`robots.dissallow`, did you mean `robots.disallow`?',
      '`preview.secrt`, did you mean `preview.secret`?',
      '`runtimeRedirects.host`, did you mean `runtimeRedirects.hosts`?',
      '`sitemap.tll`, did you mean `sitemap.ttl`?',
    ])
  })

  it('refuses, at load, the values the types would have refused, as config-invalid and never a TypeError', async () => {
    const trailing = await load('export default { trailingSlash: \'sometimes\', base: \'blog\', serve: { compress: 7 } } as never\n')
    const lang = await load('export default { lang: 5 } as never\n')
    const locale = await load('export default { i18n: { locales: [\'en\'], default: \'fr\' } }\n')
    const fine = await load('export default { lang: \'en\', trailingSlash: \'always\', serve: { compress: false } }\n')

    expect(trailing).toMatchObject({ code: 'config-invalid' })
    expect(String(trailing)).toContain('`trailingSlash` is "sometimes"')
    expect(String(trailing)).toContain('`serve.compress` is 7')
    expect(lang).toMatchObject({ code: 'config-invalid' })
    expect(String(lang)).toContain('`lang` is 5, expected a string')
    expect(String(locale)).toContain('`i18n.default` is "fr"')
    expect(fine).toMatchObject({ lang: 'en', trailingSlash: 'always' })
  })

  it('refuses a list a function returned that is no list, as the same value written out', async () => {
    const written = await load('export default { security: { hosts: \'example.com\' } } as never\n')
    const loaded = await load('export default { security: { hosts: async () => \'example.com\' } } as never\n')
    const fine = await load('export default { security: { hosts: async () => [\'example.com\'] } }\n')

    expect(written).toMatchObject({ code: 'config-invalid' })
    expect(loaded).toMatchObject({ code: 'config-invalid' })
    expect(String(loaded)).toBe(String(written))
    expect(fine).toMatchObject({ security: { hosts: ['example.com'] } })
  })

  it('checks an extension\'s config the same way', async () => {
    const error = await load('export default { extensions: [{ name: \'lib\', config: { lang: 5 } }] } as never\n')

    expect(String(error)).toContain('the config of the extension lib has a value of the wrong kind: `lang` is 5')
  })

  it('loads a `lints` entry naming a lint kay removed, as `pages()`, `testSite()` and `kay build` read the config', async () => {
    const loaded = await load('export default { lints: { \'deprecated-package-names\': \'allow\', \'missing-alt\': \'warn\' } }\n') as { lints?: Record<string, string> }
    const root = await scratchDir('config-values-')

    await Bun.write(join(root, 'kay.config.ts'), 'export default { lints: { \'deprecated-package-names\': \'allow\' } }\n')

    expect(loaded.lints).toEqual({ 'deprecated-package-names': 'allow', 'missing-alt': 'warn' })
    expect((await withConfig(root, {})).lints).toEqual({ 'deprecated-package-names': 'allow' })
    expect(unknownConfigKeys({ lints: { 'deprecated-package-names': 'allow' } })).toEqual([])
    expect(invalidConfigValues({ lints: { 'deprecated-package-names': 'allow' } })).toEqual([])
  })
})
