import { describe, expect, it } from 'bun:test'
import { mergeConfig } from '../src/config-loader'
import { mergeBags, REMOVED_KEYS, unknownConfigKeys } from '../src/config-shape'

describe('the config keys of before 1.88', () => {
  it('names the key that replaced a removed one', () => {
    expect(unknownConfigKeys({ routes: 'a', api: 'b', content: 'c', storage: 'd', maxSizes: {}, settings: {}, fileStore: undefined })).toEqual(['`routes`, did you mean `dirs.routes`?', '`api`, did you mean `dirs.api`?', '`content`, did you mean `contentConfig`?', '`storage`, did you mean `store.files`?', '`maxSizes`, did you mean `limits.byPath`?', '`settings`, did you mean `librarySettings`?', '`fileStore`, did you mean `store.files`?'])
    expect(unknownConfigKeys({ routesDir: 'a', compress: false, onError: () => undefined, saveData: false })).toEqual(['`routesDir`, did you mean `dirs.routes`?', '`compress`, did you mean `serve.compress`?', '`onError`, did you mean `observe.onError`?', '`saveData`, did you mean `client.saveData`?'])
    expect(unknownConfigKeys({ setting: {}, contnt: 'x' })).toEqual(['`setting`', '`contnt`'])
  })

  it('points every flat key at a bag key, and the bags take them', () => {
    const flat = Object.entries(REMOVED_KEYS).filter(([, target]) => target.includes('.') && !target.startsWith('store.'))

    expect(flat.length).toBeGreaterThan(20)
    expect(unknownConfigKeys(Object.fromEntries(flat.map(([key]) => [key, 1])))).toHaveLength(flat.length)
    expect(unknownConfigKeys(Object.fromEntries(flat.map(([, target]) => target.split('.') as [string, string]).map(([group, key]) => [group, { [key]: undefined }])))).toEqual([])
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
