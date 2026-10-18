import type { TestPage, TestSite } from '../src/test'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { chromium } from 'playwright-core'
import { analytics } from '../src/server/analytics'
import { browserPath, testSite } from '../src/test'

// Assigning undefined to an environment variable stores the text "undefined".
function restoreEnvironment(value: string | undefined): void {
  if (value === undefined)
    delete process.env.NODE_ENV
  else
    process.env.NODE_ENV = value
}

const path = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)

interface Received { body: { url: string, referrer: string } }

const received: Received[] = []
let provider: ReturnType<typeof Bun.serve>
let before: string | undefined
let site: TestSite
let page: TestPage

// A provider taking JSON posts at /collect and serving a tracker at /script.js that posts once when it runs.
function fakeProvider(): ReturnType<typeof Bun.serve> {
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)

      if (url.pathname === '/script.js')
        return new Response(`fetch("http://localhost:${server.port}/collect", { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"url":"loaded","referrer":""}' })`, { headers: { 'content-type': 'text/javascript' } })

      received.push({ body: await request.json() as Received['body'] })

      return Response.json({}, { status: 202 })
    },
  })

  return server
}

// The visits reaching the provider so far, once `count` have.
async function visits(count: number): Promise<Received[]> {
  const until = Date.now() + 5000

  while (received.length < count && Date.now() < until)
    await Bun.sleep(25)

  return received
}

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('analytics in a browser', () => {
  beforeAll(async () => {
    before = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    provider = fakeProvider()
    site = await testSite({
      routes: 'tests/fixtures/navigation/src/routes',
      browser: { path },
      onError: () => undefined,
      extensions: [analytics({ provider: 'plausible', domain: 'example.com', host: `http://localhost:${provider.port}`, consent: { text: 'Count?', agree: 'Yes', refuse: 'No' } })],
    })
    page = await site.open('/')
  }, 60_000)

  afterAll(async () => {
    await site?.close()
    await provider?.stop(true)
    restoreEnvironment(before)
  })

  it('asks first and counts nothing until the visitor agrees', async () => {
    await page.waitFor('section[aria-labelledby] button')
    await Bun.sleep(200)

    expect(await page.text('#kay-analytics-notice')).toBe('Count?')
    expect(received).toEqual([])
  })

  it('shows a labelled region the keyboard reaches, with named buttons, and leaves the focus where it was', async () => {
    const notice = await page.evaluate(() => {
      const region = document.querySelector('section[aria-labelledby]')!
      const label = document.getElementById(region.getAttribute('aria-labelledby')!)

      return { label: label?.textContent, inside: region.contains(document.activeElement), buttons: [...region.querySelectorAll('button')].map(button => button.textContent) }
    })

    expect(notice).toEqual({ label: 'Count?', inside: false, buttons: ['Yes', 'No'] })

    const reached: string[] = []

    for (let at = 0; at < 40 && reached.length < 2; at++) {
      await page.press('Tab')

      const focused = await page.evaluate(() => document.activeElement?.closest('section[aria-labelledby]') === null ? '' : document.activeElement?.textContent ?? '')

      if (focused !== '')
        reached.push(focused)
    }

    expect(reached).toEqual(['Yes', 'No'])
    expect(await page.a11y('section[aria-labelledby]')).toEqual([])
  })

  it('counts the page once they agree, then each page swap with the page it left as referrer', async () => {
    await page.click('section[aria-labelledby] button:first-of-type')
    const first = await visits(1)

    expect(first[0]!.body.url).toMatch(/\/$/)
    expect(await page.count('section[aria-labelledby]')).toBe(0)

    await page.click('a.second')
    await page.waitFor('h1', { text: 'Second' })
    const second = await visits(2)

    expect(second[1]!.body.url).toMatch(/\/second$/)
    expect(second[1]!.body.referrer).toMatch(/localhost:\d+\/$/)
  })

  it('stops counting after a refusal made through the settings link', async () => {
    await page.evaluate(() => {
      const link = document.createElement('button')

      link.setAttribute('data-analytics-consent', '')
      link.id = 'settings'
      document.body.append(link)
    })
    await page.click('#settings')
    await page.waitFor('section[aria-labelledby] button')
    await page.click('section[aria-labelledby] button:last-of-type')
    await page.back()
    await Bun.sleep(300)

    expect(received).toHaveLength(2)
    expect(page.errors).toEqual([])
  })
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('a custom provider in a browser', () => {
  let custom: TestSite
  let opened: TestPage

  beforeAll(async () => {
    before = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    provider = fakeProvider()
    received.length = 0
    custom = await testSite({
      routes: 'tests/fixtures/navigation/src/routes',
      browser: { path },
      onError: () => undefined,
      extensions: [analytics({ provider: 'custom', script: `http://localhost:${provider.port}/script.js`, endpoint: `http://localhost:${provider.port}/collect`, consent: true })],
    })
    opened = await custom.open('/')
  }, 60_000)

  afterAll(async () => {
    await custom?.close()
    await provider?.stop(true)
    restoreEnvironment(before)
  })

  it('loads the tracker only after a yes, and reloads without it after a refusal', async () => {
    await opened.waitFor('section[aria-labelledby] button')
    await Bun.sleep(200)

    expect(received).toEqual([])
    expect(await opened.count('script[src$="/_kay/analytics/script.js"]')).toBe(0)

    await opened.click('section[aria-labelledby] button:first-of-type')
    await visits(1)

    expect(received[0]!.body.url).toBe('loaded')
    expect(await opened.count('script[src$="/_kay/analytics/script.js"]')).toBe(1)

    await opened.evaluate(() => {
      const link = document.createElement('button')

      link.setAttribute('data-analytics-consent', '')
      link.id = 'settings'
      document.body.append(link)
    })
    await opened.click('#settings')
    await opened.waitFor('section[aria-labelledby] button')
    await opened.click('section[aria-labelledby] button:last-of-type')
    await Bun.sleep(500)

    expect(await opened.count('script[src$="/_kay/analytics/script.js"]')).toBe(0)
    expect(received).toHaveLength(1)
  })
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('the consent signal in a browser', () => {
  let own: TestSite
  let opened: TestPage

  beforeAll(async () => {
    before = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    provider = fakeProvider()
    received.length = 0
    own = await testSite({
      routes: 'tests/fixtures/analytics-consent/src/routes',
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

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('a counter that asks no one, in a browser', () => {
  let open: TestSite
  let opened: TestPage

  beforeAll(async () => {
    before = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    provider = fakeProvider()
    received.length = 0
    open = await testSite({
      routes: 'tests/fixtures/navigation/src/routes',
      browser: { path },
      onError: () => undefined,
      extensions: [analytics({ provider: 'plausible', domain: 'example.com', host: `http://localhost:${provider.port}`, info: { text: 'Counting', ok: 'Fine', optOut: 'Stop' } })],
    })
    opened = await open.open('/')
  }, 60_000)

  afterAll(async () => {
    await open?.close()
    await provider?.stop(true)
    restoreEnvironment(before)
  })

  it('counts the first page at once and shows the information line with its opt-out', async () => {
    await opened.waitFor('section[aria-labelledby] button')

    expect(await opened.text('#kay-analytics-notice')).toBe('Counting')
    expect((await visits(1))[0]!.body.url).toMatch(/\/$/)
    expect(await opened.a11y('section[aria-labelledby]')).toEqual([])
  })

  it('counts nothing more when the visitor closes the line with OK', async () => {
    await opened.click('section[aria-labelledby] button:first-of-type')
    await Bun.sleep(300)

    expect(received).toHaveLength(1)
  })

  it('counts no more once the visitor opts out, across a page swap', async () => {
    await opened.evaluate(() => {
      const link = document.createElement('button')

      link.setAttribute('data-analytics-consent', '')
      link.id = 'settings'
      document.body.append(link)
    })
    await opened.click('#settings')
    await opened.waitFor('section[aria-labelledby] button')
    await opened.click('section[aria-labelledby] button:last-of-type')

    expect(await opened.evaluate(() => document.cookie)).toContain('kay_analytics=no')
    await opened.click('a.second')
    await opened.waitFor('h1', { text: 'Second' })
    await Bun.sleep(300)

    expect(received).toHaveLength(1)
    expect(opened.errors).toEqual([])
  })
})
