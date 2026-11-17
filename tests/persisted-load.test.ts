import { afterAll, expect, it } from 'bun:test'
import { persistedCookie, testSite } from '../src/test'

const site = await testSite({ dirs: { routes: 'tests/fixtures/persisted-load/src/routes' }, islands: false })

afterAll(async () => {
  await site.close()
})

const folder = async (cookie?: string) => (await (cookie === undefined ? site : site.as(cookie)).visit('/')).find('p.folder')[0]?.text

it('reads a persisted cookie signal in the page\'s server fence', async () => {
  expect(await folder(persistedCookie('open', 'b'))).toBe('b')
})

it('reads a value its values refuse as the default', async () => {
  expect(await folder(persistedCookie('open', 'zzz'))).toBe('none')
  expect(await folder(persistedCookie('open', 7))).toBe('none')
  expect(await folder('open=not-json')).toBe('none')
})

it('reads the default with no cookie', async () => {
  expect(await folder()).toBe('none')
})

it('keeps concurrent requests apart', async () => {
  const seen = await Promise.all(['a', 'b', 'a', 'b', 'none'].map(async value => folder(persistedCookie('open', value))))

  expect(seen).toEqual(['a', 'b', 'a', 'b', 'none'])
})
