import type { TestPage, TestSite } from '../src/test'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { analytics } from '../src/server/analytics'
import { browserPath, testSite } from '../src/test'
import { fakeProvider, received, restoreEnvironment, visits } from './analytics-browser-support'
import { scratchStore } from './helpers/scratch-store'

const path = browserPath()

let provider: ReturnType<typeof Bun.serve>
let before: string | undefined
let site: TestSite
let page: TestPage

interface Sent { name?: string, props?: Record<string, unknown> }

const sent = () => received.map(entry => entry.body as unknown as Sent)

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('analytics events in a browser', () => {
  beforeAll(async () => {
    before = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    provider = fakeProvider()
    site = await testSite({
      root: 'tests/fixtures/navigation',
      browser: { path },
      store: await scratchStore(),
      observe: { onError: () => undefined },
      extensions: [analytics({ provider: 'plausible', domain: 'example.com', host: `http://localhost:${provider.port}`, events: { outbound: true, downloads: true } })],
    })
    page = await site.open('/')
    await visits(1)
    // Links in the test never navigate away.
    await page.evaluate(() => document.addEventListener('click', event => event.preventDefault()))
  }, 60_000)

  afterAll(async () => {
    await site?.close()
    await provider?.stop(true)
    restoreEnvironment(before)
  })

  it('counts kayAnalytics.track with its props', async () => {
    const count = received.length

    await page.evaluate(() => (window as unknown as { kayAnalytics: { track: (name: string, props: object) => void } }).kayAnalytics.track('signup', { plan: 'pro' }))
    await visits(count + 1)

    expect(sent().at(-1)).toMatchObject({ name: 'signup', props: { plan: 'pro' } })
  })

  it('counts a click on an element with data-analytics-event, its data-analytics-prop-* as props', async () => {
    const count = received.length

    await page.evaluate(() => {
      document.body.insertAdjacentHTML('beforeend', '<button id="buy" data-analytics-event="buy" data-analytics-prop-plan="pro" data-analytics-prop-seat-count="3"><span id="inner">Buy</span></button>')
    })
    await page.click('#inner')
    await visits(count + 1)

    expect(sent().at(-1)).toMatchObject({ name: 'buy', props: { 'plan': 'pro', 'seat-count': '3' } })
  })

  it('counts a link to another site and a file download with the address and no query, and an ordinary link nothing', async () => {
    const count = received.length

    await page.evaluate(() => {
      document.body.insertAdjacentHTML('beforeend', '<a id="out" href="https://elsewhere.example/page?token=1#x">out</a><a id="file" href="/files/guide.PDF?v=2">file</a><a id="plain" href="/second">plain</a><a id="mail" href="mailto:a@b.example">mail</a>')
    })
    await page.click('#plain')
    await page.click('#mail')
    await page.click('#out')
    await page.click('#file')
    await visits(count + 2)

    const [outbound, download, ...rest] = sent().slice(count)

    expect(outbound).toMatchObject({ name: 'Outbound Link: Click', props: { url: 'https://elsewhere.example/page' } })
    expect(download!.name).toBe('File Download')
    expect(download!.props!.url).toMatch(/\/files\/guide\.PDF$/)
    expect(rest).toEqual([])
  })

  it('counts a file on another site as a download, not an outbound link', async () => {
    const count = received.length

    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<a id="far" href="https://elsewhere.example/big.zip">far</a>'))
    await page.click('#far')
    await visits(count + 1)
    await Bun.sleep(100)

    expect(sent().slice(count).map(entry => entry.name)).toEqual(['File Download'])
  })
})
