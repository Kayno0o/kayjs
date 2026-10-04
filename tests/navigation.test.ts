import type { Browser, Page } from 'playwright-core'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { chromium } from 'playwright-core'

const LISTENING = /port (\d+)/
const browserInstalled = existsSync(chromium.executablePath())

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
      throw new Error(`the navigation fixture exited without listening: ${await new Response(child.stderr).text()}`)

    output += new TextDecoder().decode(value)
  }

  reader.releaseLock()

  return LISTENING.exec(output)![1]!
}

// Set on the window before a navigation: still there after it means the page was swapped, not loaded.
async function sameDocument(): Promise<boolean> {
  return page.evaluate(() => (window as { kayAlive?: boolean }).kayAlive === true)
}

describe.skipIf(!browserInstalled)('page swap in Chromium', () => {
  beforeAll(async () => {
    server = Bun.spawn(['bun', 'tests/fixtures/navigation/server.ts'], { env: { ...process.env, NODE_ENV: 'production' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    origin = `http://localhost:${await listeningPort(server)}`
    browser = await chromium.launch({ headless: true })
    page = await browser.newPage()
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
    await server?.exited
  })

  it('swaps the next page in, a persistent island keeping its state and its element', async () => {
    const errors: string[] = []

    page.on('pageerror', error => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error')
        errors.push(message.text())
    })
    await page.goto(origin)
    await page.click('button.player')
    await page.click('button.player')
    await page.locator('button.player', { hasText: 'Played 2' }).waitFor()
    await page.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
      ;(document.querySelector('slot[data-persist]') as HTMLElement & { kayMark?: string }).kayMark = 'kept'
    })

    const fetched: string[] = []

    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/second')
        fetched.push(request.method())
    })
    await page.hover('a.second')
    await Bun.sleep(400)
    await page.click('a.second')
    await page.locator('h1', { hasText: 'Second' }).waitFor()

    expect(await sameDocument()).toBe(true)
    expect(new URL(page.url()).pathname).toBe('/second')
    expect(await page.title()).toBe('Second')
    // Fetched once, when hovered: the swap took that response rather than asking again, and the browser's own prefetch was off.
    expect(fetched).toEqual(['GET'])
    expect(await page.evaluate(() => document.querySelector('script[type="speculationrules"]'))).toBeNull()
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('h1')!).color)).toBe('rgb(1, 2, 3)')
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('H1')
    expect(await page.textContent('button.player')).toBe('Played 2')
    expect(await page.evaluate(() => (document.querySelector('slot[data-persist]') as HTMLElement & { kayMark?: string }).kayMark)).toBe('kept')
    await page.click('button.player')
    expect(await page.textContent('button.player')).toBe('Played 3')
    expect(errors).toEqual([])
  })

  it('checks a form against its action\'s schema before posting, with the server\'s message', async () => {
    await page.fill('input[name="title"]', 'ab')
    await page.click('form button')

    expect(await page.evaluate(() => document.querySelector('input')!.validationMessage)).toBe('Too short')
    expect(await page.locator('p.error, p.done').count()).toBe(0)
  })

  it('posts a form without a reload, pending meanwhile, and shows what the action answered', async () => {
    await page.fill('input[name="title"]', 'abcd')
    await page.click('form button')
    await page.locator('form[aria-busy="true"]').waitFor()
    await page.locator('p.done', { hasText: 'Added abcd' }).waitFor()

    expect(await page.locator('form[aria-busy]').count()).toBe(0)
    expect(await sameDocument()).toBe(true)

    await page.fill('input[name="title"]', 'taken')
    await page.click('form button')
    await page.locator('p.error', { hasText: 'Already taken' }).waitFor()

    expect(await page.inputValue('input[name="title"]')).toBe('taken')
    expect(await sameDocument()).toBe(true)
    expect(await page.textContent('button.player')).toBe('Played 3')
  })

  it('goes back by swapping too, the page as it was', async () => {
    await page.goBack()
    await page.locator('h1', { hasText: 'Home' }).waitFor()

    expect(await sameDocument()).toBe(true)
    expect(await page.textContent('button.player')).toBe('Played 3')
  })

  it('swaps in a streamed page with its blocks in place', async () => {
    await page.click('a.later')
    await page.locator('p.answer', { hasText: 'The answer is 42' }).waitFor()

    expect(await page.locator('p.pending').count()).toBe(0)
    expect(await sameDocument()).toBe(true)
    await page.goBack()
    await page.locator('h1', { hasText: 'Home' }).waitFor()
  })

  it('runs the page\'s loads again after an island calls an action', async () => {
    const before = await page.textContent('p.bumps')

    await page.click('button.bump')
    await page.locator('p.bumps', { hasNotText: before! }).waitFor()

    expect(await sameDocument()).toBe(true)
  })

  it('restores where the page was scrolled to when going back', async () => {
    await page.goto(origin)
    await page.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
      scrollTo(0, 1500)
      document.querySelector<HTMLElement>('a.second')!.click()
    })
    await page.locator('h1', { hasText: 'Second' }).waitFor()

    expect(await page.evaluate(() => scrollY)).toBe(0)

    await page.evaluate(() => scrollTo(0, 700))
    await Bun.sleep(300)
    await page.goBack()
    await page.locator('h1', { hasText: 'Home' }).waitFor()

    expect(await page.evaluate(() => scrollY)).toBe(1500)

    await page.goForward()
    await page.locator('h1', { hasText: 'Second' }).waitFor()

    expect(await page.evaluate(() => scrollY)).toBe(700)
    expect(await sameDocument()).toBe(true)

    await page.reload()
    await page.locator('h1', { hasText: 'Second' }).waitFor()
    await page.waitForFunction(() => scrollY === 700)
  })

  it('goes back to a jump within the page by scrolling, the page left as it is', async () => {
    await page.goto(origin)
    await page.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
      const link = document.createElement('a')

      link.href = '#end'
      link.className = 'jump'
      document.querySelector('div[style]')!.id = 'end'
      document.body.append(link)
      link.click()
    })
    await page.waitForFunction(() => scrollY > 0)
    await page.click('button.player')
    await page.goBack()
    await page.waitForFunction(() => scrollY === 0)

    expect(await sameDocument()).toBe(true)
    expect(await page.textContent('button.player')).toBe('Played 1')
  })

  it('still works without JavaScript, as full page loads', async () => {
    const context = await browser.newContext({ javaScriptEnabled: false })
    const plain = await context.newPage()

    try {
      await plain.goto(`${origin}/second`)
      await plain.fill('input[name="title"]', 'taken')
      await plain.click('form button')
      await plain.locator('p.error', { hasText: 'Already taken' }).waitFor()
      await plain.click('a.home')
      await plain.locator('h1', { hasText: 'Home' }).waitFor()
    }
    finally {
      await context.close()
    }
  })

  it('loads a page from a link opting out', async () => {
    await page.click('a.reload')
    await page.locator('h1', { hasText: 'Plain' }).waitFor()

    expect(await sameDocument()).toBe(false)
  })

  it('shares a module\'s signal between the islands of a page', async () => {
    await page.goto(`${origin}/state`)
    await page.locator('p.total', { hasText: 'Total 5' }).waitFor()
    await page.click('button.adder')
    await page.locator('p.total', { hasText: 'Total 6' }).waitFor()
  })

  it('renders a try block\'s catch block once it throws, keeping the one the server rendered, and reports the error', async () => {
    const reports: string[] = []
    const warnings: string[] = []

    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/_kay/error')
        reports.push(request.postData() ?? '')
    })
    page.on('console', (message) => {
      if (message.type() === 'warning')
        warnings.push(message.text())
    })
    await page.goto(`${origin}/fallback`)
    await page.locator('p.fragile', { hasText: 'Fine' }).waitFor()

    expect(await page.textContent('p.unavailable')).toBe('Unavailable')

    await page.click('button.break')
    await page.locator('p.fallback', { hasText: 'Failed: Fragile broke' }).waitFor()

    expect(await page.locator('p.fragile').count()).toBe(0)
    await Bun.sleep(100)
    expect(reports.map(body => JSON.parse(body) as Record<string, unknown>)).toEqual([{ name: 'Error', message: 'Fragile broke', stack: expect.any(String), island: 'tests/fixtures/navigation/src/components/fragile.kay', url: `${origin}/fallback` }])
    expect(warnings).toEqual([])
  })

  it('hands what a component provides to what it renders in the browser too, a block rendered later included', async () => {
    const warnings: string[] = []

    page.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error')
        warnings.push(message.text())
    })
    await page.goto(`${origin}/tone`)
    await page.click('button.open')
    await page.locator('button.open', { hasText: 'Open' }).waitFor()

    expect(await page.locator('section.box p.tone').allTextContents()).toEqual(['loud', 'loud'])
    expect(await page.locator('body > p.tone').textContent()).toBe('layout')
    expect(await page.textContent('button.reader')).toBe('plain')
    expect(warnings).toEqual([])
  })

  it('keeps a persisted signal in a cookie the server renders with, and one in localStorage applied once hydrated', async () => {
    const warnings: string[] = []

    page.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error')
        warnings.push(message.text())
    })
    await page.goto(`${origin}/state`)
    await page.click('button.theme')
    await page.click('button.note')
    await page.locator('button.note', { hasText: 'Note kept' }).waitFor()

    expect(await (await page.request.get(`${origin}/alone`)).text()).toContain('Theme <!--[-->dark<!--]-->')

    await page.goto(`${origin}/alone`)
    await page.locator('button.note', { hasText: 'Note kept' }).waitFor()

    expect(await page.textContent('button.theme')).toBe('Theme dark')
    expect(warnings).toEqual([])
  })
})
