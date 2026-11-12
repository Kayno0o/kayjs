import { describe, expect, it } from 'bun:test'
import { mergeConfig } from '../src/config-loader'
import { mergeBags, REMOVED_KEYS, unknownConfigKeys } from '../src/config-shape'

describe('the config keys of before 1.88', () => {
  it('names the key that replaced a removed one', () => {
    expect(unknownConfigKeys({ routes: 'a', api: 'b', content: 'c', storage: 'd', maxSizes: {}, settings: {}, fileStore: undefined })).toEqual(['`routes`, moved to `dirs.routes`', '`api`, moved to `dirs.api`', '`content`, moved to `contentConfig`', '`storage`, moved to `store.files`', '`maxSizes`, moved to `limits.byPath`', '`settings`, moved to `librarySettings`', '`fileStore`, moved to `store.files`'])
    expect(unknownConfigKeys({ routesDir: 'a', compress: false, onError: () => undefined, saveData: false })).toEqual(['`routesDir`, moved to `dirs.routes`', '`compress`, moved to `serve.compress`', '`onError`, moved to `observe.onError`', '`saveData`, moved to `client.saveData`'])
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
    expect(unknownConfigKeys({ dirs: { routes: 'a' }, limits: { body: 1 }, serve: { compress: true }, observe: { log: false }, client: { saveData: false } })).toEqual([])
    expect(unknownConfigKeys({ dirs: { route: 'a' }, client: { saveDat: false }, limits: { max: 1 } })).toEqual(['`dirs.route`, did you mean `dirs.routes`?', '`client.saveDat`, did you mean `client.saveData`?', '`limits.max`'])
  })
})
