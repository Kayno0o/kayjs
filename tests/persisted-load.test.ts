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

it('reads it in a layout\'s server fence too, valid, refused and missing', async () => {
  const layout = async (cookie?: string) => (await (cookie === undefined ? site : site.as(cookie)).visit('/')).find('p.layout')[0]?.text

  expect(await layout(persistedCookie('open', 'b'))).toBe('b')
  expect(await layout(persistedCookie('open', 'zzz'))).toBe('none')
  expect(await layout()).toBe('none')
})

it('reads a value its values refuse as the default', async () => {
  expect(await folder(persistedCookie('open', 'zzz'))).toBe('none')
  expect(await folder(persistedCookie('open', 7))).toBe('none')
  expect(await folder('open=not-json')).toBe('none')
})

it('reads the default with no cookie', async () => {
  expect(await folder()).toBe('none')
})

it('makes the answer private, and varies on the cookie even when the page sets its own caching', async () => {
  const plain = await site.as(persistedCookie('open', 'a')).visit('/')
  const cached = await site.as(persistedCookie('open', 'a')).visit('/?cache')

  expect(plain.headers.get('cache-control')).toBe('private, no-cache')
  expect(plain.headers.get('vary')?.toLowerCase()).toContain('cookie')
  expect(cached.headers.get('cache-control')).toBe('public, max-age=60')
  expect(cached.headers.get('vary')?.toLowerCase()).toContain('cookie')
})

it('keeps concurrent requests apart', async () => {
  const seen = await Promise.all(['a', 'b', 'a', 'b', 'none'].map(async value => folder(persistedCookie('open', value))))

  expect(seen).toEqual(['a', 'b', 'a', 'b', 'none'])
})
