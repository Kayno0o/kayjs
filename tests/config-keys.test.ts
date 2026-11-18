import { describe, expect, it } from 'bun:test'
import { defineConfig } from '../src/config'
import { mergeConfig } from '../src/config-loader'
import { mergeBags, REMOVED_KEYS, unknownConfigKeys } from '../src/config-shape'

describe('the config keys of before 1.88', () => {
  it('names the key that replaced a removed one', () => {
    expect(unknownConfigKeys({ routes: 'a', api: 'b', content: 'c', storage: 'd', maxSizes: {}, settings: {}, fileStore: undefined })).toEqual(['`routes`, moved to `dirs.routes`', '`api`, moved to `dirs.api`', '`content`, moved to `contentConfig`', '`storage`, moved to `store.files`', '`maxSizes`, moved to `limits.byPath`', '`settings`, moved to `librarySettings`', '`fileStore`, moved to `store.files`'])
    expect(unknownConfigKeys({ routesDir: 'a', compress: false, onError: () => undefined, saveData: false })).toEqual(['`routesDir`, moved to `dirs.routes`', '`compress`, moved to `serve.compress`', '`saveData`, moved to `client.saveData`'])
    expect(unknownConfigKeys({ prefech: 'eager', compres: false })).toEqual(['`prefech`, did you mean `prefetch`, moved to `client.prefetch`?', '`compres`, did you mean `compress`, moved to `serve.compress`?'])
    expect(unknownConfigKeys({ setting: {}, contnt: 'x' })).toEqual(['`setting`, did you mean `settings`, moved to `librarySettings`?', '`contnt`, did you mean `content`, moved to `contentConfig`?'])
  })

  it('points every flat key at a bag key, and the bags take them', () => {
    const flat = Object.entries(REMOVED_KEYS).filter(([, target]) => target.includes('.') && !target.startsWith('store.'))

    expect(flat.length).toBeGreaterThan(20)
    expect(unknownConfigKeys(Object.fromEntries(flat.map(([key]) => [key, 1])))).toHaveLength(flat.length)
    expect(unknownConfigKeys(Object.fromEntries(flat.map(([, target]) => target.split('.') as [string, string]).map(([group, key]) => [group, { [key]: undefined }])))).toEqual([])
  })

  it('refuses the keys 1.98 renamed, 1.102 having dropped them', () => {
    expect(unknownConfigKeys({ serve: { apiPath: '/v1' }, live: { perMinute: 1 }, images: { perMinute: 1 } })).toHaveLength(3)
  })

  it('refuses a flat key in the options of a call', () => {
    expect(() => mergeConfig({}, { compress: false } as never)).toThrow(/no longer reads: `compress`, now `serve\.compress`/)
  })
})

describe('the grouped config keys', () => {
  it('lays the options of a call over the config one bag deep, an undefined option leaving the config\'s value', () => {
    expect(mergeBags({ client: { navigation: true, prefetch: false }, dirs: { routes: 'a' }, lang: 'en' }, { client: { navigation: false, prefetch: undefined }, lang: undefined, minify: true })).toEqual({ client: { navigation: false, prefetch: false }, dirs: { routes: 'a' }, lang: 'en', minify: true })
    expect(mergeBags({ dirs: { routes: 'a' } }, { dirs: undefined })).toEqual({ dirs: { routes: 'a' } })
    expect(mergeBags({}, { serve: { compress: false } })).toEqual({ serve: { compress: false } })
  })

  it('checks the keys of each bag', () => {
    expect(unknownConfigKeys({ dirs: { routes: 'a' }, limits: { body: 1 }, serve: { compress: true }, ops: { observe: { log: false } }, client: { saveData: false } })).toEqual([])
    expect(unknownConfigKeys({ dirs: { route: 'a' }, client: { saveDat: false }, limits: { max: 1 } })).toEqual(['`dirs.route`, did you mean `dirs.routes`?', '`client.saveDat`, did you mean `client.saveData`?', '`limits.max`'])
  })
})

describe('the unknown keys defineConfig refuses by type', () => {
  it('checks every option bag of the config, at any depth, with no list of them', () => {
    // @ts-expect-error a mistyped key of a bag the type once left unchecked
    expect(defineConfig({ assets: { images: { widht: 1 } } })).toBeDefined()
    // @ts-expect-error a bag held by a bag
    expect(defineConfig({ security: { cookies: { httpOnlee: true } } })).toBeDefined()
    // @ts-expect-error a bag three levels down, whose own `family` is required
    expect(defineConfig({ assets: { images: { card: { font: { family: 'Inter', wieght: 400 } } } } })).toBeDefined()
    // @ts-expect-error a bag with required keys
    expect(defineConfig({ i18n: { locales: ['en'], default: 'en', mesages: 'm' } })).toBeDefined()
    // @ts-expect-error the extra key of a favicon
    expect(defineConfig({ assets: { favicon: { image: 'a.png', svg: 'a.svg', sizes: [1] } } })).toBeDefined()
    // @ts-expect-error a bag that takes a switch
    expect(defineConfig({ ops: { health: { pth: '/up' } } })).toBeDefined()
    // @ts-expect-error the library bags
    expect(defineConfig({ store: { sesions: undefined } })).toBeDefined()
  })

  it('takes every shape of an option typed by a union of objects, and still refuses a typo in a plain bag', () => {
    expect(defineConfig({ mcp: { token: { env: 'MCP_KEY' } } })).toBeDefined()
    expect(defineConfig({ mcp: { token: { file: 'data/mcp-key' } } })).toBeDefined()
    expect(defineConfig({ mcp: { token: 'secret' } })).toBeDefined()
    expect(defineConfig({ ops: { metrics: { token: { file: 'data/metrics-key' } } } })).toBeDefined()
    expect(defineConfig({ cors: { origins: '*', credentials: false } })).toBeDefined()
    expect(defineConfig({ cors: { origins: ['https://a.fr'], credentials: true } })).toBeDefined()
    // @ts-expect-error a mistyped key inside a member of the union
    expect(defineConfig({ mcp: { token: { flie: 'data/mcp-key' } } })).toBeDefined()
    // @ts-expect-error a mistyped key of a plain bag beside them
    expect(defineConfig({ mcp: { tokn: 'secret' } })).toBeDefined()
  })

  it('leaves an object a library hands over alone, as a store carrying a symbol key', () => {
    const store = { sql: undefined, ping: async () => true, [Symbol.asyncDispose]: async () => undefined }

    expect(defineConfig({ store })).toBeDefined()
    expect(defineConfig({ store: { ...store, files: undefined } })).toBeDefined()
  })

  it('takes true, false or a bag where a feature switches, and keeps the contextual type of a callback', () => {
    const config = defineConfig({
      robots: true,
      sitemap: false,
      assets: { favicon: true, images: { placeholder: true, rateLimit: false, card: { font: { family: 'Inter' } } } },
      security: { cookies: true, csp: false },
      ops: { health: { check: () => true } },
      live: { rateLimit: true },
      preview: true,
      proxy: true,
      client: { offline: false, hydration: { visible: '200px' } },
      onError: event => void event.error,
    })

    expect(config.robots).toBe(true)
  })
})
