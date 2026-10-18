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
    provider = Bun.serve({
      port: 0,
      async fetch(request) {
        received.push({ body: await request.json() as Received['body'] })

        return Response.json({}, { status: 202 })
      },
    })
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
    await page.waitFor('aside button')
    await Bun.sleep(200)

    expect(await page.text('aside p')).toBe('Count?')
    expect(received).toEqual([])
  })

  it('counts the page once they agree, then each page swap with the page it left as referrer', async () => {
    await page.click('aside button:first-of-type')
    const first = await visits(1)

    expect(first[0]!.body.url).toMatch(/\/$/)
    expect(await page.count('aside')).toBe(0)

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
    await page.waitFor('aside button')
    await page.click('aside button:last-of-type')
    await page.back()
    await Bun.sleep(300)

    expect(received).toHaveLength(2)
    expect(page.errors).toEqual([])
  })
})
