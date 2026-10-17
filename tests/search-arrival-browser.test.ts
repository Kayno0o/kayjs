import type { Browser, Page } from 'playwright-core'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { chromium } from 'playwright-core'

const LISTENING = /port (\d+)/
const executablePath = process.env.BUN_CHROME_PATH !== undefined && process.env.BUN_CHROME_PATH !== '' ? process.env.BUN_CHROME_PATH : chromium.executablePath()
const browserInstalled = existsSync(executablePath)

let server: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
let browser: Browser
let page: Page
let origin: string

async function listeningPort(child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>): Promise<string> {
  const reader = child.stdout.getReader()
  let output = ''

  for (let match = LISTENING.exec(output); !match; match = LISTENING.exec(output)) {
    const { value, done } = await reader.read()

    if (done)
      throw new Error(`the arrival fixture exited without listening: ${await new Response(child.stderr).text()}`)

    output += new TextDecoder().decode(value)
  }

  reader.releaseLock()

  return LISTENING.exec(output)![1]!
}

// The words the page has highlighted, and how far it is scrolled.
async function marks(): Promise<string[]> {
  return page.evaluate(() => [...CSS.highlights.get('kay-search') ?? []].map(range => (range as unknown as Range).toString()))
}

describe.skipIf(!browserInstalled && (process.env.CI ?? '') === '')('a page opened from a search hit in Chromium', () => {
  beforeAll(async () => {
    server = Bun.spawn(['bun', 'tests/fixtures/arrival/server.ts'], { env: { ...process.env, NODE_ENV: 'production' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    origin = `http://localhost:${await listeningPort(server)}`
    browser = await chromium.launch({ headless: true, executablePath })
    page = await browser.newPage()
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
    await server?.exited
  })

  it('marks the words of the section on a full load, scrolling to the first, and injects nothing', async () => {
    await page.goto(`${origin}/guide?kay_q=needle#second`)
    await page.waitForFunction(() => CSS.highlights.has('kay-search'))

    expect(await marks()).toEqual(['needle', 'NEEDLE'])
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(2000)
    expect(await page.evaluate(() => (window as { pwned?: number }).pwned)).toBeUndefined()
    expect(await page.locator('mark').count()).toBe(0)
  })

  it('marks them after a swap too, in the new section, and clears them on a page without the words', async () => {
    await page.goto(origin)
    await page.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
    })
    await page.click('a.hit')
    await page.waitForFunction(() => CSS.highlights.has('kay-search'))

    expect(await page.evaluate(() => (window as { kayAlive?: boolean }).kayAlive)).toBe(true)
    expect(await marks()).toEqual(['needle', 'NEEDLE'])
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(2000)

    await page.goBack()
    await page.waitForFunction(() => !CSS.highlights.has('kay-search'))
  })

  it('marks the section of a link to the same page and query, which the browser jumps to', async () => {
    await page.goto(`${origin}/guide?kay_q=needle#second`)
    await page.waitForFunction(() => CSS.highlights.has('kay-search'))
    await page.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true

      const link = document.createElement('a')

      link.href = '/guide?kay_q=needle#third'
      link.className = 'again'
      document.body.append(link)
      link.click()
    })
    await page.waitForFunction(() => [...CSS.highlights.get('kay-search') ?? []].map(range => (range as unknown as Range).toString()).join() === 'needle')

    expect(await page.evaluate(() => (window as { kayAlive?: boolean }).kayAlive)).toBe(true)
    expect(await page.evaluate(() => location.hash)).toBe('#third')
  })

  it('leaves a link to a heading of the same page, a table of contents entry, to the browser, marking the words in the section it jumps to', async () => {
    const fetched: string[] = []

    // A visit differing by its hash alone would not load the page afresh.
    await page.goto('about:blank')
    await page.goto(`${origin}/guide?kay_q=needle#second`)
    await page.waitForFunction(() => CSS.highlights.has('kay-search'))
    page.on('request', (request) => {
      if (request.isNavigationRequest() || request.headers()['x-kay-navigate'] !== undefined)
        fetched.push(request.url())
    })
    await page.click('a.toc')
    await page.waitForFunction(() => location.hash === '#third')

    await page.waitForFunction(() => [...CSS.highlights.get('kay-search') ?? []].map(range => (range as unknown as Range).toString()).join() === 'needle')

    expect(fetched).toEqual([])
  })

  it('marks the text above the first heading for a hit with no anchor', async () => {
    await page.goto(`${origin}/guide?kay_q=needle`)
    await page.waitForFunction(() => CSS.highlights.has('kay-search'))

    expect(await marks()).toEqual(['Needle'])
  })
})
