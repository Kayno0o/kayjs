import type { TestPage, TestSite } from '../src/test'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { analytics } from '../src/server/analytics'
import { browserPath, testSite } from '../src/test'
import { fakeProvider, received, restoreEnvironment, visits } from './analytics-browser-support'

const path = browserPath()
let provider: ReturnType<typeof Bun.serve>
let before: string | undefined

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('the consent signal in a browser', () => {
  let own: TestSite
  let opened: TestPage

  beforeAll(async () => {
    before = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    provider = fakeProvider()
    received.length = 0
    own = await testSite({
      root: 'tests/fixtures/analytics-consent',
      browser: { path },
      onError: () => undefined,
      extensions: [analytics({ provider: 'plausible', domain: 'example.com', host: `http://localhost:${provider.port}`, consent: { notice: false } })],
    })
    opened = await own.open('/')
  }, 60_000)

  afterAll(async () => {
    await own?.close()
    await provider?.stop(true)
    restoreEnvironment(before)
  })

  it('renders the answer in the request\'s cookie on the server, so a page never flashes the wrong one', async () => {
    expect(await (await own.fetch('/')).text()).toContain('asking')
    expect(await (await own.fetch('/', { headers: { cookie: 'kay_analytics=yes' } })).text()).toMatch(/class="state"[^>]*>yes</)
    expect(await (await own.fetch('/', { headers: { cookie: 'kay_analytics=bogus' } })).text()).toContain('asking')
  })

  it('shows no notice of kay\'s, counts nothing until the app answers, and reads the cookie kay writes', async () => {
    await opened.waitFor('p.state', { text: 'asking' })
    await Bun.sleep(200)

    expect(await opened.count('section[aria-labelledby]')).toBe(0)
    expect(received).toEqual([])

    await opened.click('button.yes')
    await opened.waitFor('p.state', { text: 'yes' })

    expect(await opened.evaluate(() => document.cookie)).toContain('kay_analytics=yes')
    expect((await visits(1))[0]!.body.url).toMatch(/\/$/)
  })

  it('keeps the answer across a page swap, and an island of the next page reads and writes the same one', async () => {
    await opened.click('a.next')
    await opened.waitFor('h1', { text: 'Second' })

    expect(await opened.text('p.second-state')).toBe('yes')

    await opened.click('button.no')
    await opened.waitFor('p.second-state', { text: 'no' })
    await opened.waitFor('p.state', { text: 'no' })

    expect(await opened.evaluate(() => (window as unknown as { kayAnalytics: { consent: () => string } }).kayAnalytics.consent())).toBe('no')
  })

  it('asks again with an empty answer, and counts again after a yes', async () => {
    await opened.click('button.reset')
    await opened.waitFor('p.state', { text: 'asking' })

    expect(await opened.evaluate(() => document.cookie)).not.toContain('kay_analytics')

    const before = received.length

    await opened.click('button.second-yes')
    await opened.waitFor('p.state', { text: 'yes' })
    await visits(before + 1)

    expect(received.length).toBeGreaterThan(before)
    expect(opened.errors).toEqual([])
  })
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('the consent signal before the tracker has loaded, in a browser', () => {
  let own: TestSite
  let opened: TestPage

  beforeAll(async () => {
    before = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    provider = fakeProvider()
    received.length = 0
    own = await testSite({
      root: 'tests/fixtures/analytics-consent',
      browser: { path },
      onError: () => undefined,
      extensions: [analytics({ provider: 'plausible', domain: 'example.com', host: `http://localhost:${provider.port}`, consent: { notice: false, maxAge: '1234s' } })],
    })
    opened = await own.open('/')
  }, 60_000)

  afterAll(async () => {
    await own?.close()
    await provider?.stop(true)
    restoreEnvironment(before)
  })

  it('writes the cookie with the app\'s maxAge', async () => {
    await opened.waitFor('p.state', { text: 'asking' })

    const written = await opened.evaluate(() => {
      delete (window as unknown as { kayAnalytics?: unknown }).kayAnalytics

      const writes: string[] = []
      const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!

      Object.defineProperty(document, 'cookie', { configurable: true, get: (): string => descriptor.get!.call(document) as string, set: (value: string) => {
        writes.push(value)
        descriptor.set!.call(document, value)
      } })
      document.querySelector<HTMLButtonElement>('button.yes')!.click()

      return writes
    })

    expect(written).toHaveLength(1)
    expect(written[0]).toContain('kay_analytics=yes; max-age=1234;')
  })
})
