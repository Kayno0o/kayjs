import type { Browser, ConsoleMessage, Page } from 'playwright-core'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { chromium } from 'playwright-core'

const LISTENING = /port (\d+)/
// CI installs Chromium and names it in BUN_CHROME_PATH, where a missing browser fails rather than skipping.
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

// A full Chromium, as CI installs, asks for a favicon the fixture has none of.
function pageError(message: ConsoleMessage): boolean {
  return message.type() === 'error' && !message.location().url.endsWith('/favicon.ico')
}

describe.skipIf(!browserInstalled && (process.env.CI ?? '') === '')('page swap in Chromium', () => {
  beforeAll(async () => {
    server = Bun.spawn(['bun', 'tests/fixtures/navigation/server.ts'], { env: { ...process.env, NODE_ENV: 'production' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    origin = `http://localhost:${await listeningPort(server)}`
    browser = await chromium.launch({ headless: true, executablePath })
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
      if (pageError(message))
        errors.push(message.text())
    })
    await page.goto(origin)
    await page.click('button.player')
    await page.click('button.player')
    await page.locator('button.player', { hasText: 'Played 2' }).waitFor()
    expect(await page.textContent('button.page-note')).toBe('/')
    await page.click('button.page-note')
    expect(await page.textContent('button.page-note')).toBe('edited')
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
    // Kept, it takes the props the new page gives it, and the note edited over the old ones follows them.
    expect(await page.textContent('button.page-note')).toBe('/second')
    await page.click('button.player')
    expect(await page.textContent('button.player')).toBe('Played 3')
    // Back on the first page, the edit made there is long out of date.
    await page.click('a.home')
    await page.locator('button.page-note', { hasText: /^\/$/ }).waitFor()
    expect(await page.textContent('button.page-note')).toBe('/')
    expect(await page.textContent('button.player')).toBe('Played 3')
    await page.click('a.second')
    await page.locator('h1', { hasText: 'Second' }).waitFor()
    expect(errors).toEqual([])
  })

  it('checks a form against its action\'s schema before posting, with the server\'s message', async () => {
    await page.fill('input[name="title"]', 'ab')
    await page.click('form button')
    await page.waitForFunction(() => document.querySelector('input')!.validationMessage === 'Too short')

    expect(await page.locator('p.error, p.done').count()).toBe(0)
  })

  it('loads the form checks once a form is used, and checks a form submitted before they loaded', async () => {
    const fresh = await browser.newPage()
    const checksLoaded = async (): Promise<boolean> => fresh.evaluate(() => performance.getEntriesByType('resource').some(entry => (/\/validate-[^/]*\.js$/).test(entry.name)))

    await fresh.goto(`${origin}/second`)
    await fresh.locator('form').waitFor()
    await Bun.sleep(200)

    expect(await checksLoaded()).toBe(false)

    await fresh.evaluate(() => {
      document.querySelector<HTMLInputElement>('input[name="title"]')!.value = 'ab'
      document.querySelector('form')!.requestSubmit()
    })
    await fresh.waitForFunction(() => document.querySelector('input')!.validationMessage === 'Too short')

    expect(await checksLoaded()).toBe(true)
    expect(await fresh.locator('p.error, p.done').count()).toBe(0)
    await fresh.close()
  })

  it('loads the swap once a link is pointed at or followed, and swaps a link clicked before it loaded', async () => {
    const fresh = await browser.newPage()
    const swapLoaded = async (): Promise<boolean> => fresh.evaluate(() => performance.getEntriesByType('resource').some(entry => (/\/page-swap-[^/]*\.js$/).test(entry.name)))

    await fresh.goto(origin)
    await Bun.sleep(200)

    expect(await swapLoaded()).toBe(false)

    // A click with no pointer before it, as a keyboard or a script makes.
    await fresh.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
      document.querySelector<HTMLAnchorElement>('a.second')!.click()
    })
    await fresh.locator('h1', { hasText: 'Second' }).waitFor()

    expect(await fresh.evaluate(() => (window as { kayAlive?: boolean }).kayAlive)).toBe(true)
    expect(await swapLoaded()).toBe(true)
    await fresh.close()
  })

  it('loads the next page fully when the swap cannot load', async () => {
    const fresh = await browser.newPage()

    await fresh.route(/\/page-swap-[^/]*\.js$/, async route => route.abort())
    await fresh.goto(origin)
    await fresh.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
    })
    await fresh.click('a.second')
    await fresh.locator('h1', { hasText: 'Second' }).waitFor()

    expect(await fresh.evaluate(() => (window as { kayAlive?: boolean }).kayAlive)).toBeUndefined()
    expect(new URL(fresh.url()).pathname).toBe('/second')
    await fresh.close()
  })

  it('leaves a form to the server when its checks cannot load, reporting no error', async () => {
    const fresh = await browser.newPage()
    const posts: string[] = []

    fresh.on('request', (request) => {
      if (request.method() === 'POST')
        posts.push(new URL(request.url()).pathname.replace(/\/_kay\/action\/.*/, '/_kay/action'))
    })
    await fresh.route(/\/validate-[^/]*\.js$/, async route => route.abort())
    await fresh.goto(`${origin}/second`)
    await fresh.focus('input[name="title"]')
    await fresh.fill('input[name="title"]', 'ab')
    await Promise.all([
      fresh.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.startsWith('/_kay/action/')),
      fresh.click('form button'),
    ])

    // Sent unchecked for the server to refuse, the failed load reported to no one.
    expect(posts).toEqual(['/_kay/action'])
    await fresh.close()
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
      if (message.type() === 'warning' || pageError(message))
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
      if (message.type() === 'warning' || pageError(message))
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

  it('focuses the field a post was refused for, described by its message', async () => {
    await page.goto(`${origin}/second`)
    await page.fill('input[name="title"]', 'ab')
    await page.focus('button.unchecked')
    await page.keyboard.press('Enter')
    await page.locator('p.title-error', { hasText: 'Too short' }).waitFor()
    await page.waitForFunction(() => document.activeElement?.getAttribute('name') === 'title')

    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-describedby'))).toBe('add-title-error')
    expect(await page.evaluate(() => document.getElementById('add-title-error')?.textContent)).toBe('Too short')
  })

  it('announces a form\'s own refusal, the button that posted it focused again', async () => {
    await page.goto(`${origin}/second`)
    await page.fill('input[name="title"]', 'busy')
    await page.focus('form button')
    await page.keyboard.press('Enter')
    await page.locator('p.form-error', { hasText: 'Try later' }).waitFor()
    await page.waitForFunction(() => [...document.querySelectorAll('body > [aria-live="polite"]')].some(region => region.textContent === 'Try later'))

    expect(await page.evaluate(() => document.querySelector('form')?.getAttribute('aria-describedby'))).toBe('add-error')
    expect(await page.evaluate(() => document.activeElement === document.querySelector('form button'))).toBe(true)
  })

  it('animates a swap where a stylesheet opts in under a condition that holds, and never for a visitor asking for less motion', async () => {
    const transitions = async (reducedMotion: 'reduce' | 'no-preference', css: string): Promise<number> => {
      const fresh = await browser.newPage({ reducedMotion })

      await fresh.goto(origin)
      await fresh.addStyleTag({ content: css })
      await fresh.evaluate(() => {
        const start = document.startViewTransition.bind(document)
        const counted = window as { kayTransitions?: number }

        counted.kayTransitions = 0
        document.startViewTransition = ((update: () => void) => {
          counted.kayTransitions!++

          return start(update)
        }) as typeof document.startViewTransition
      })
      await fresh.click('a.second')
      await fresh.locator('h1', { hasText: 'Second' }).waitFor()

      const count = await fresh.evaluate(() => (window as { kayTransitions?: number }).kayTransitions!)

      await fresh.close()

      return count
    }

    expect(await transitions('no-preference', '@media (prefers-reduced-motion: no-preference) { @view-transition { navigation: auto; } }')).toBe(1)
    expect(await transitions('no-preference', '@supports (display: grid) { @view-transition { navigation: auto; } }')).toBe(1)
    expect(await transitions('reduce', '@media (prefers-reduced-motion: no-preference) { @view-transition { navigation: auto; } }')).toBe(0)
    expect(await transitions('reduce', '@view-transition { navigation: auto; }')).toBe(0)
  })

  it('announces the swapped page without making it any taller, so one filling the screen gets no scrollbar', async () => {
    await page.goto(origin)
    await page.click('a.second')
    await page.waitForFunction(() => document.querySelector('body > [aria-live="polite"]')?.textContent)

    // The page as a layout filling the screen renders it, the announcer after it, where a `min-h-dvh` wrapper ends.
    const overflow = await page.evaluate(() => {
      const filler = document.createElement('div')

      document.body.style.margin = '0'

      for (const child of document.body.children) {
        if (!child.hasAttribute('aria-live'))
          (child as HTMLElement).style.display = 'none'
      }

      filler.style.height = '100vh'
      document.body.prepend(filler)

      return document.documentElement.scrollHeight - innerHeight
    })

    expect(overflow).toBe(0)
  })
})
