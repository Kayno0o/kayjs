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
