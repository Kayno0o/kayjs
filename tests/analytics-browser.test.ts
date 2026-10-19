import type { TestPage, TestSite } from '../src/test'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { chromium } from 'playwright-core'
import { analytics } from '../src/server/analytics'
import { NOTICE_SCRIPT } from '../src/server/analytics-script'
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

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('the notice across page swaps, focus, lifetime and exclusions, in a browser', () => {
  let own: TestSite
  let opened: TestPage

  const NOTICE = 'section[aria-labelledby]'
  const cookieAge = async () => opened.evaluate(async () => {
    const cookie = await (window as unknown as { cookieStore: { get: (name: string) => Promise<{ expires: number } | null> } }).cookieStore.get('kay_analytics')

    return cookie === null ? -1 : Math.round((cookie.expires - Date.now()) / 86_400_000)
  })
  const opener = async () => opened.evaluate(() => {
    if (!document.getElementById('settings')) {
      const link = document.createElement('button')

      link.setAttribute('data-analytics-consent', '')
      link.id = 'settings'
      link.textContent = 'Settings'
      document.body.prepend(link)
    }
  })

  beforeAll(async () => {
    before = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    provider = fakeProvider()
    received.length = 0
    own = await testSite({
      routes: 'tests/fixtures/navigation/src/routes',
      browser: { path },
      onError: () => undefined,
      extensions: [analytics({ provider: 'plausible', domain: 'example.com', host: `http://localhost:${provider.port}`, consent: true, policyUrl: '/privacy', exclude: ['/second', '/*/admin'] })],
    })
    opened = await own.open('/')
  }, 60_000)

  afterAll(async () => {
    await own?.close()
    await provider?.stop(true)
    restoreEnvironment(before)
  })

  it('names the provider and links the policy', async () => {
    await opened.waitFor(`${NOTICE} button`)

    expect(await opened.text('#kay-analytics-notice')).toContain('with Plausible')
    expect(await opened.evaluate(() => document.querySelector<HTMLAnchorElement>('#kay-analytics-notice a')?.getAttribute('href'))).toBe('/privacy')
  })

  it('keeps the notice through a page swap made before an answer, and the settings link still opens it', async () => {
    await opened.click('a.second')
    await opened.waitFor('h1', { text: 'Second' })

    expect(await opened.count(NOTICE)).toBe(1)

    await opener()
    await opened.click(`${NOTICE} button:last-of-type`)
    expect(await opened.count(NOTICE)).toBe(0)
    await opened.click('#settings')
    await opened.waitFor(`${NOTICE} button`)
    expect(await opened.count(NOTICE)).toBe(1)
  })

  it('remembers a refusal for as long as a yes, 180 days', async () => {
    await opened.click(`${NOTICE} button:last-of-type`)
    expect(await opened.evaluate(() => document.cookie)).toContain('kay_analytics=no')
    expect(await cookieAge()).toBeGreaterThanOrEqual(179)
    expect(await cookieAge()).toBeLessThanOrEqual(180)
    await opened.click('#settings')
    await opened.click(`${NOTICE} button:first-of-type`)
    expect(await cookieAge()).toBeGreaterThanOrEqual(179)
    expect(await cookieAge()).toBeLessThanOrEqual(180)
  })

  it('moves focus to the first button when a click opens the notice, and gives it back to that control after an answer', async () => {
    await opened.evaluate(() => document.getElementById('settings')!.focus())
    await opened.click('#settings')
    await opened.waitFor(`${NOTICE} button`)

    expect(await opened.evaluate(() => document.activeElement?.textContent)).toBe('Agree')

    await opened.press('Enter')

    expect(await opened.count(NOTICE)).toBe(0)
    expect(await opened.evaluate(() => document.activeElement?.id)).toBe('settings')
  })

  it('shows the notice again when an answer is taken back, with the focus where it was', async () => {
    await opened.evaluate(() => document.getElementById('settings')!.focus())
    await opened.click('#settings')
    await opened.waitFor(`${NOTICE} button`)
    await opened.evaluate(() => (window as unknown as { kayAnalytics: { decide: (value: string) => void } }).kayAnalytics.decide(''))
    await opened.waitFor(`${NOTICE} button`)

    expect(await opened.count(NOTICE)).toBe(1)
    expect(await opened.evaluate(() => document.activeElement?.id)).toBe('settings')
    await opened.click(`${NOTICE} button:first-of-type`)
    expect(await opened.evaluate(() => document.cookie)).toContain('kay_analytics=yes')
  })

  it('counts a page, and counts nothing for an excluded one', async () => {
    const before = received.length

    await opened.click('a.home')
    await opened.waitFor('h1', { text: 'Home' })
    await visits(before + 1)
    await opened.click('a.second')
    await opened.waitFor('h1', { text: 'Second' })
    await opened.click('a.later')
    await visits(before + 2)
    await Bun.sleep(300)

    const urls = received.slice(before).map(visit => new URL(visit.body.url).pathname)

    expect(urls).toEqual(['/', '/later'])
    expect(opened.errors).toEqual([])
  })

  it('leaves out a path matching a wildcard pattern and a page that says noindex, however the meta is written', async () => {
    const before = received.length
    const swap = async (path: string) => opened.evaluate((to) => {
      document.dispatchEvent(new CustomEvent('kay:navigate', { detail: { url: location.origin + to } }))
    }, path)

    await swap('/fr/admin/users')
    await swap('/fr/admin')
    await swap('/admin')
    await visits(before + 1)
    await opened.evaluate(() => document.head.append(Object.assign(document.createElement('meta'), { name: 'robots', content: 'NoIndex, nofollow' })))
    await swap('/quiet')
    await opened.evaluate(() => document.querySelector('meta[name=robots]')!.remove())
    await swap('/loud')
    await visits(before + 2)
    await Bun.sleep(300)

    expect(received.slice(before).map(visit => new URL(visit.body.url).pathname)).toEqual(['/admin', '/loud'])
  })

  it('puts the base before a policy path, and leaves an address alone', async () => {
    const other = await own.open('/plain')
    const hrefs = await other.evaluate((script) => {
      const found: (string | null)[] = []

      for (const [scope, policy] of [['/shop', '/privacy'], ['/', '/privacy'], ['/shop', 'https://example.com/policy']] as const) {
        const root = window as unknown as { kayAnalytics: object }

        root.kayAnalytics = { data: { texts: '{"en":{"text":"Hi","agree":"Yes","refuse":"No","policy":"Policy"}}', policy }, scope, decide: () => undefined, wanted: () => undefined }
        document.querySelector('section[aria-labelledby]')?.remove()
        // eslint-disable-next-line no-new-func, ts/no-unsafe-call
        new Function(script)()
        found.push(document.querySelector('#kay-analytics-notice a')?.getAttribute('href') ?? null)
      }

      return found
    }, NOTICE_SCRIPT)

    expect(hrefs).toEqual(['/shop/privacy', '/privacy', 'https://example.com/policy'])
  })
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('a notice that failed to load, in a browser', () => {
  let flaky: TestSite
  let opened: TestPage
  let failures = 1

  beforeAll(async () => {
    before = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    provider = fakeProvider()
    received.length = 0
    flaky = await testSite({
      routes: 'tests/fixtures/navigation/src/routes',
      browser: { path },
      onError: () => undefined,
      use: [new Elysia().onRequest(({ request }) => {
        return request.url.endsWith('/notice.js') && failures-- > 0 ? new Response('down', { status: 503 }) : undefined
      })],
      extensions: [analytics({ provider: 'plausible', domain: 'example.com', host: `http://localhost:${provider.port}`, consent: true })],
    })
    opened = await flaky.open('/')
  }, 60_000)

  afterAll(async () => {
    await flaky?.close()
    await provider?.stop(true)
    restoreEnvironment(before)
  })

  it('asks again on the next ask, and a click\'s opener survives the automatic one', async () => {
    await Bun.sleep(300)
    expect(await opened.count('section[aria-labelledby]')).toBe(0)
    expect(await opened.count('script[src$="/notice.js"]')).toBe(0)

    await opened.evaluate(() => {
      const link = document.createElement('button')

      link.setAttribute('data-analytics-consent', '')
      link.id = 'settings'
      document.body.append(link)
    })
    await opened.click('#settings')
    await opened.waitFor('section[aria-labelledby] button')

    expect(await opened.evaluate(() => document.activeElement?.textContent)).toBe('Agree')
  })
})
