import type { Browser, ConsoleMessage, Dialog, Page } from 'playwright-core'
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

// Forwards to the fixture, the answer to the first action post cut off by closing the connection short of the body it promised once the server has run it.
function lossyProxy(target: number) {
  let cut = false

  const listener = Bun.listen<{ upstream?: Bun.Socket, pending: Uint8Array[], drop: boolean }>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      async open(client) {
        client.data = { pending: [], drop: false }

        const upstream = await Bun.connect({
          hostname: '127.0.0.1',
          port: target,
          socket: {
            data(_, chunk) {
              if (client.data.drop) {
                // The headers arrive, promising a body that never does.
                client.write(new TextEncoder().encode(new TextDecoder().decode(chunk).replace(/content-length: \d+\r\n/i, '').replace('\r\n\r\n', '\r\ncontent-length: 50\r\n\r\n')))
                setTimeout(() => client.end(), 20)
              }
              else {
                client.write(chunk)
              }
            },
            close() {
              client.end()
            },
          },
        })

        client.data.upstream = upstream

        for (const chunk of client.data.pending)
          upstream.write(chunk)
      },
      data(client, chunk) {
        if (!cut && new TextDecoder().decode(chunk.subarray(0, 24)).startsWith('POST /_kay/action')) {
          cut = true
          client.data.drop = true
        }

        if (client.data.upstream)
          client.data.upstream.write(chunk)
        else
          client.data.pending.push(chunk)
      },
      close(client) {
        client.data.upstream?.end()
      },
    },
  })

  return {
    port: listener.port,
    stop() {
      listener.stop(true)
    },
  }
}

// Set on the window before a navigation: still there after it means the page was swapped, not loaded.
async function sameDocument(): Promise<boolean> {
  return page.evaluate(() => (window as { kayAlive?: boolean }).kayAlive === true)
}

async function until(holds: () => boolean | Promise<boolean>): Promise<void> {
  while (!await holds())
    await Bun.sleep(20)
}

// Whatever the page had queued after its load or its last event has run: two frames and a task later, for a test asserting something did not happen.
async function settled(on: Page): Promise<void> {
  await on.evaluate(async () => new Promise<void>((resolve) => {
    // A page in the background gets no frames, so a timer ends the wait too.
    setTimeout(resolve, 100)
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve)))
  }))
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
    const hovered = page.waitForRequest(request => new URL(request.url()).pathname === '/second')

    await page.hover('a.second')
    await hovered
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

  it('loads the form checks once a form is used, and checks a form submitted before they loaded', async () => {
    const fresh = await browser.newPage()
    const checksLoaded = async (): Promise<boolean> => fresh.evaluate(() => performance.getEntriesByType('resource').some(entry => (/\/validate-[^/]*\.js$/).test(entry.name)))

    await fresh.goto(`${origin}/second`)
    await fresh.locator('form').waitFor()
    await settled(fresh)

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
    await settled(fresh)

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

  it('reloads the page in its own history entry on a refresh when the swap cannot load', async () => {
    const fresh = await browser.newPage()

    await fresh.route(/\/page-swap-[^/]*\.js$/, async route => route.abort())
    await fresh.goto(origin)
    await fresh.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
    })

    const entries = await fresh.evaluate(() => history.length)

    await fresh.click('button.bump')
    await fresh.waitForFunction(() => (window as { kayAlive?: boolean }).kayAlive === undefined && document.readyState === 'complete')

    expect(await fresh.evaluate(() => [location.pathname, history.length])).toEqual(['/', entries])
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
    const posted = page.waitForRequest(request => request.method() === 'POST')

    await page.fill('input[name="title"]', 'abcd')
    await page.click('form button')
    // Naming its page, as a `Referer` the app's `referrer-policy` cuts would not.
    expect((await posted).headers()['x-kay-page']).toBe(new URL(page.url()).pathname)
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

  it('fires kay:navigate on document once each swapped page is in place, with its URL, and not on a full load', async () => {
    // A page of its own, as the tests after this one count on the document and the history the shared page holds.
    const own = await browser.newPage()

    await own.goto(origin)
    await own.evaluate(() => {
      const seen: string[] = []

      ;(window as { kayNavigated?: string[] }).kayNavigated = seen
      document.addEventListener('kay:navigate', (event) => {
        seen.push(`${(event as CustomEvent<{ url: string }>).detail.url}|${document.querySelector('h1')?.textContent ?? ''}`)
      })
    })
    expect(await own.evaluate(() => (window as { kayNavigated?: string[] }).kayNavigated)).toEqual([])
    await own.click('a.second')
    await own.locator('h1', { hasText: 'Second' }).waitFor()
    expect(await own.evaluate(() => (window as { kayNavigated?: string[] }).kayNavigated)).toEqual([`${origin}/second|Second`])
    await own.goBack()
    await own.locator('h1', { hasText: 'Home' }).waitFor()
    expect(await own.evaluate(() => (window as { kayNavigated?: string[] }).kayNavigated)).toEqual([`${origin}/second|Second`, `${origin}/|Home`])
    await own.close()
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

  it('keeps on a refresh an island whose children the page renders the same, and renders afresh one whose children changed', async () => {
    await page.evaluate(() => {
      for (const box of document.querySelectorAll('slot[data-component$="box.kay"]'))
        (box as HTMLElement & { kayMark?: string }).kayMark = 'kept'
    })
    await page.click('section.box:has(p.same) button.box-count')
    await page.locator('section.box:has(p.same) button.box-count', { hasText: 'Box 1' }).waitFor()

    const before = await page.textContent('p.boxed-bumps')

    await page.click('button.bump')
    await page.locator('p.boxed-bumps', { hasNotText: before! }).waitFor()

    expect(await page.evaluate(() => [...document.querySelectorAll('slot[data-component$="box.kay"]')].map(box => (box as HTMLElement & { kayMark?: string }).kayMark ?? 'fresh'))).toEqual(['kept', 'fresh'])
    expect(await page.textContent('section.box:has(p.same) button.box-count')).toBe('Box 1')
    await page.click('section.box:has(p.boxed-bumps) button.box-count')
    await page.locator('section.box:has(p.boxed-bumps) button.box-count', { hasText: 'Box 1' }).waitFor()
  })

  it('changes on <html> only what the server sets differently for the next page, where a script left it as served, a class token by token', async () => {
    // Its CRLF reaches the attribute as a LF, which the served value is compared with.
    const label = 'say "hi" & <b>\nbye'
    const root = async (): Promise<Record<string, string | string[]>> => page.evaluate(() => {
      const { attributes, classList } = document.documentElement

      return { ...Object.fromEntries([...attributes].filter(({ name }) => name !== 'class' && name !== 'aria-busy').map(({ name, value }) => [name, value])), class: [...classList].sort() }
    })
    const go = async (link: string, heading: string) => {
      await page.click(`a.${link}`)
      await page.locator('h1', { hasText: heading }).waitFor()
      expect(await sameDocument()).toBe(true)
    }

    await page.goto(origin)
    await page.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
    })
    expect(await root()).toEqual({ 'lang': 'en', 'data-theme': 'light', 'data-label': label, 'class': ['served'] })
    // Untouched, the theme follows the server's, and the page's class tokens join the layout's, then go with the page.
    await go('second', 'Second')
    expect(await root()).toEqual({ 'lang': 'en', 'data-theme': 'dark', 'data-label': label, 'data-second': '', 'class': ['second', 'served'] })
    await go('home', 'Home')
    expect(await root()).toEqual({ 'lang': 'en', 'data-theme': 'light', 'data-label': label, 'class': ['served'] })
    // A theme toggle's value stays through a page serving the same and one serving another.
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark'
      document.documentElement.classList.add('dark')
    })
    await go('second', 'Second')
    expect(await root()).toEqual({ 'lang': 'en', 'data-theme': 'dark', 'data-label': label, 'data-second': '', 'class': ['dark', 'second', 'served'] })
    await go('home', 'Home')
    expect(await root()).toEqual({ 'lang': 'en', 'data-theme': 'dark', 'data-label': label, 'class': ['dark', 'served'] })
    // A page whose server sets nothing takes off what the last one's set, but for the theme the toggle changed.
    await go('later', 'Later')
    expect(await root()).toEqual({ 'lang': 'en', 'data-theme': 'dark', 'class': ['dark'] })
    // Back, the server's values come back through the meta's JSON as they were.
    await page.goBack()
    await page.locator('h1', { hasText: 'Home' }).waitFor()
    expect(await sameDocument()).toBe(true)
    expect(await root()).toEqual({ 'lang': 'en', 'data-theme': 'dark', 'data-label': label, 'class': ['dark', 'served'] })
  })

  it('keeps through a swap what a script changed or added in the head and on <body>, and drops what the server alone served', async () => {
    const state = async () => page.evaluate(() => ({
      themes: [...document.querySelectorAll('meta[name="theme-color"]')].map(meta => meta.getAttribute('content')),
      images: [...document.querySelectorAll('meta[property="og:image"]')].map(meta => meta.getAttribute('content')),
      added: document.querySelectorAll('meta[name="script-added"]').length,
      secondOnly: document.querySelectorAll('meta[name="second-only"]').length,
      mode: document.body.dataset.mode,
    }))
    const go = async (link: string, heading: string) => {
      await page.click(`a.${link}`)
      await page.locator('h1', { hasText: heading }).waitFor()
      expect(await sameDocument()).toBe(true)
    }

    await page.goto(origin)
    await page.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
    })
    // A dark mode toggle recolouring the browser's bar, a loader adding a tag, a script marking the body, all before the swap loads.
    await page.evaluate(() => {
      document.querySelector('meta[name="theme-color"]')!.setAttribute('content', '#123456')
      document.querySelector('meta[property="og:image"]')!.setAttribute('content', '/x.png')
      const meta = document.createElement('meta')

      meta.name = 'script-added'
      document.head.append(meta)
      document.body.dataset.mode = 'dark'
    })
    await go('second', 'Second')
    expect(await state()).toEqual({ themes: ['#123456'], images: ['/x.png', '/b.png'], added: 1, secondOnly: 1, mode: 'dark' })
    await go('home', 'Home')
    expect(await state()).toEqual({ themes: ['#123456'], images: ['/x.png', '/b.png'], added: 1, secondOnly: 0, mode: 'dark' })
    // A page serving other values leaves the script's metas in place of its own, one for one, the served one beside them kept.
    await go('later', 'Later')
    expect(await state()).toEqual({ themes: ['#123456'], images: ['/x.png', '/b.png'], added: 1, secondOnly: 0, mode: 'dark' })
    await go('home', 'Home')
    expect(await state()).toEqual({ themes: ['#123456'], images: ['/x.png', '/b.png'], added: 1, secondOnly: 0, mode: 'dark' })
  })

  it('serializes each head element and script a fixed number of times per swap', async () => {
    await page.goto(origin)
    await page.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
      const counts = { html: 0 }
      const original = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML')!

      Object.defineProperty(Element.prototype, 'outerHTML', { ...original, get(this: Element) {
        counts.html++

        return original.get!.call(this) as string
      } })
      ;(window as { counts?: typeof counts }).counts = counts
    })
    await page.click('a.second')
    await page.locator('h1', { hasText: 'Second' }).waitFor()

    const measured = await page.evaluate(() => ({
      html: (window as { counts?: { html: number } }).counts!.html,
      elements: document.head.children.length + document.scripts.length,
    }))

    expect(measured.html).toBeLessThanOrEqual(measured.elements * 3)
  })

  it('restores where the page was scrolled to when going back, focusing its heading without scrolling and announcing its title', async () => {
    await page.goto(origin)
    await page.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
      scrollTo(0, 1500)
      document.querySelector<HTMLElement>('a.second')!.click()
    })
    await page.locator('h1', { hasText: 'Second' }).waitFor()

    expect(await page.evaluate(() => scrollY)).toBe(0)

    await page.evaluate(() => scrollTo(0, 700))
    await page.waitForFunction(() => (history.state as { scroll?: number[] } | null)?.scroll?.[1] === 700)
    await page.goBack()
    await page.locator('h1', { hasText: 'Home' }).waitFor()

    expect(await page.evaluate(() => scrollY)).toBe(1500)
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('H1')
    await page.waitForFunction(() => [...document.querySelectorAll('body > [aria-live="polite"]')].at(-1)?.textContent === document.title)

    await page.goForward()
    await page.locator('h1', { hasText: 'Second' }).waitFor()

    expect(await page.evaluate(() => scrollY)).toBe(700)
    expect(await sameDocument()).toBe(true)

    await page.reload()
    await page.locator('h1', { hasText: 'Second' }).waitFor()
    await page.waitForFunction(() => scrollY === 700)
  })

  it('keeps what the next page renders again, a scrolled sidebar keeping its scroll, and gives it the next page\'s attributes', async () => {
    await page.goto(origin)
    await page.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
      const side = document.querySelector<HTMLElement & { kayMark?: string }>('#side')!

      side.kayMark = 'kept'
      side.scrollTop = 200
      document.querySelector<HTMLElement>('#drawer')!.showPopover()
      document.querySelector<HTMLElement>('a.second')!.click()
    })
    await page.locator('h1', { hasText: 'Second' }).waitFor()

    expect(await sameDocument()).toBe(true)
    expect(await page.evaluate(() => (document.querySelector('#side') as HTMLElement & { kayMark?: string }).kayMark)).toBe('kept')
    expect(await page.evaluate(() => document.querySelector('#side')!.scrollTop)).toBe(200)
    expect(await page.getAttribute('a.second', 'aria-current')).toBe('page')
    expect(await page.getAttribute('a.home', 'aria-current')).toBeNull()
    // A drawer left open closes as the page changes.
    expect(await page.evaluate(() => document.querySelector('#drawer')!.matches(':popover-open'))).toBe(false)
  })

  it('swaps on a browser without popovers, which throws on the :popover-open selector', async () => {
    const fresh = await browser.newPage()
    const errors: string[] = []

    fresh.on('pageerror', error => errors.push(error.message))
    await fresh.addInitScript(() => {
      Reflect.deleteProperty(HTMLElement.prototype, 'popover')
      Element.prototype.querySelectorAll = new Proxy<Element['querySelectorAll']>(Reflect.get(Element.prototype, 'querySelectorAll'), {
        apply: (select, element: Element, selectors: [string]) => {
          if (selectors[0].includes(':popover-open'))
            throw new SyntaxError(`'${selectors[0]}' is not a valid selector`)

          return Reflect.apply(select, element, selectors) as NodeListOf<Element>
        },
      })
    })
    await fresh.goto(origin)
    await fresh.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
    })
    await fresh.click('a.second')
    await fresh.locator('h1', { hasText: 'Second' }).waitFor()

    expect(await fresh.evaluate(() => (window as { kayAlive?: boolean }).kayAlive)).toBe(true)
    expect(errors).toEqual([])
    await fresh.close()
  })

  it('keeps the scroll and skips the view transition when asked, by navigate() or a link, and goes to the top otherwise', async () => {
    const fresh = await browser.newPage()
    const go = async (click: string) => {
      await fresh.goto(`${origin}/scrolled`)
      await fresh.evaluate(() => {
        const counted = window as { kayTransitions?: number, kayAlive?: boolean }
        const start = document.startViewTransition.bind(document)

        counted.kayAlive = true
        counted.kayTransitions = 0
        document.startViewTransition = ((update: () => void) => {
          counted.kayTransitions!++

          return start(update)
        }) as typeof document.startViewTransition
      })
      await fresh.addStyleTag({ content: '@view-transition { navigation: auto; }' })
      await fresh.evaluate(() => scrollTo(0, 1200))
      // Clicked from the page's script, as a real click would scroll the control into view first.
      await fresh.evaluate(selector => document.querySelector<HTMLElement>(selector)!.click(), click)
      await fresh.locator('h1', { hasText: 'Second' }).waitFor()

      return fresh.evaluate(() => ({ scroll: scrollY > 1000 ? 'kept' : scrollY, transitions: (window as { kayTransitions?: number }).kayTransitions, swapped: (window as { kayAlive?: boolean }).kayAlive === true }))
    }

    try {
      expect(await go('button.plain')).toEqual({ scroll: 0, transitions: 1, swapped: true })
      expect(await go('button.keep')).toEqual({ scroll: 'kept', transitions: 1, swapped: true })

      // A query change keeps the scroll by itself, and goes to the top when asked.
      await fresh.goto(`${origin}/scrolled`)
      await fresh.evaluate(() => scrollTo(0, 1200))
      await fresh.evaluate(() => document.querySelector<HTMLElement>('button.top')!.click())
      await fresh.waitForFunction(() => location.search === '?sort=z')
      await fresh.waitForFunction(() => scrollY === 0)

      expect(await go('button.still')).toEqual({ scroll: 'kept', transitions: 0, swapped: true })
      expect(await go('a.plain-link')).toEqual({ scroll: 0, transitions: 1, swapped: true })
      expect(await go('a.keep-link')).toEqual({ scroll: 'kept', transitions: 1, swapped: true })
      expect(await go('a.group-link')).toEqual({ scroll: 'kept', transitions: 0, swapped: true })

      // Back to the page left restores where it was, whatever kept the scroll going there.
      await fresh.goBack()
      await fresh.locator('h1', { hasText: 'Scrolled' }).waitFor()
      await fresh.waitForFunction(() => scrollY > 1000)
    }
    finally {
      await fresh.close()
    }
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

  it('asks before leaving a page with unsaved changes, once for every guard, and stays as it was when refused', async () => {
    const asked: string[] = []
    let answer = false
    const onDialog = async (dialog: Dialog) => {
      asked.push(`${dialog.type()} ${dialog.message()}`)
      await (answer ? dialog.accept() : dialog.dismiss())
    }
    // A refused leave changes nothing, so it is waited for as the question, then until the page has run what it had queued.
    const refused = async (count: number) => {
      await until(() => asked.length === count)
      await settled(page)
      expect(await page.textContent('h1')).toBe('Guarded')
      expect(await sameDocument()).toBe(true)
    }

    page.on('dialog', onDialog)

    try {
      await page.goto(origin)
      await page.evaluate(() => {
        (window as { kayAlive?: boolean }).kayAlive = true
        const link = document.createElement('a')

        link.href = '/guarded'
        link.className = 'guarded'
        document.body.append(link)
        link.click()
      })
      await page.locator('h1', { hasText: 'Guarded' }).waitFor()
      await page.fill('.two input.draft', 'draft')

      await page.click('a.second')
      await refused(1)
      expect(asked[0]).toBe('confirm This page has unsaved changes. Leave it anyway?')

      await page.click('.two button.draft-home')
      await refused(2)

      await page.fill('.two input.draft', '')
      await page.fill('.one input.draft', 'draft')
      await page.click('a.second')
      await refused(3)
      expect(asked[2]).toBe('confirm Leave for /second?')

      // Both hold changes from here on, and each leave asks once.
      await page.fill('.two input.draft', 'draft')

      await page.evaluate(() => {
        scrollTo(0, 400)
        history.back()
      })
      await refused(4)
      await page.waitForFunction(() => location.pathname === '/guarded')
      expect(await page.inputValue('.one input.draft')).toBe('draft')
      expect(await page.evaluate(() => scrollY)).toBe(400)

      // Neither an island's own URL state nor a post to an action of the page is a leave.
      await page.click('.two button.tab')
      expect(page.url()).toBe(`${origin}/guarded?tab=b`)
      await page.click('a.second')
      await refused(5)
      expect(page.url()).toBe(`${origin}/guarded?tab=b`)

      await page.click('button.save')
      await until(async () => await page.inputValue('.one input.draft') === '')
      expect(asked).toHaveLength(5)

      await page.fill('.two input.draft', 'draft')
      await page.evaluate(() => location.reload())
      await refused(6)
      expect(asked[5]).toStartWith('beforeunload')

      answer = true
      await page.evaluate(() => history.back())
      await page.locator('h1', { hasText: 'Home' }).waitFor()
      expect(asked).toHaveLength(7)
      expect(await sameDocument()).toBe(true)

      // The guards went with their page: nothing asks any more.
      await page.reload()
      await page.locator('h1', { hasText: 'Home' }).waitFor()
      expect(asked).toHaveLength(7)
    }
    finally {
      page.off('dialog', onDialog)
    }
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

  it('never fetches a rel=nofollow link ahead, and swaps it in once clicked', async () => {
    const fresh = await browser.newPage()
    const fetched: string[] = []

    fresh.on('request', (request) => {
      if (new URL(request.url()).pathname === '/state')
        fetched.push(request.url())
    })
    // The hover delay runs on a faked clock, jumped past rather than waited for.
    await fresh.clock.install()
    await fresh.goto(origin)
    await fresh.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
    })
    await fresh.hover('a.nofollow')
    await fresh.clock.runFor(1000)
    await settled(fresh)
    expect(fetched).toEqual([])
    await fresh.click('a.nofollow')
    await fresh.waitForURL(`${origin}/state`)

    expect(fetched).toHaveLength(1)
    expect(await fresh.evaluate(() => (window as { kayAlive?: boolean }).kayAlive)).toBe(true)
    await fresh.close()
  })

  it('loads a page from a link opting out', async () => {
    await page.click('a.reload')
    await page.locator('h1', { hasText: 'Plain' }).waitFor()

    expect(await sameDocument()).toBe(false)
  })

  it('loads fully a page asking for it, and one whose cross-origin isolation differs from this one\'s', async () => {
    const mark = async () => page.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
    })
    const follow = async (link: string, title: string) => {
      await mark()
      await page.click(link)
      await page.locator('h1', { hasText: title }).waitFor()
    }

    await page.goto(origin)
    await follow('a.whole', 'Whole')
    expect(await sameDocument()).toBe(false)
    // The page itself, its query changed, is still swapped in place.
    await mark()
    await page.click('button.sort')
    await page.locator('p.whole-sorted', { hasText: 'Sorted name' }).waitFor()
    expect(await sameDocument()).toBe(true)

    await follow('a.isolated', 'Isolated')
    expect(await sameDocument()).toBe(false)
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)

    await follow('a.second', 'Second')
    expect(await sameDocument()).toBe(false)
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(false)

    await follow('a.home', 'Home')
    expect(await sameDocument()).toBe(true)
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
    await until(() => reports.length > 0)
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

  it('keeps a persisted signal in the query the server renders with, its default leaving the URL plain, and merges a query into the page in place', async () => {
    const warnings: string[] = []

    page.on('console', (message) => {
      if (message.type() === 'warning' || pageError(message))
        warnings.push(message.text())
    })

    expect(await (await page.request.get(`${origin}/query?q=kept`)).text()).toContain('Searched <!--[-->kept<!--]-->')

    await page.goto(`${origin}/query?q=kept`)
    await page.fill('input.search', 'typed')
    await until(async () => page.evaluate(() => location.search === '?q=typed'))
    await page.fill('input.search', '')
    await until(async () => page.evaluate(() => location.search === ''))
    await page.fill('input.search', 'again')

    const scrolled = await page.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
      window.scrollTo(0, 1000)

      return scrollY
    })

    await page.click('button.sort')
    await page.locator('p.sorted', { hasText: 'Sorted name' }).waitFor()

    expect(await sameDocument()).toBe(true)
    expect(await page.evaluate(() => [location.search, scrollY, document.activeElement?.className])).toEqual(['?q=again&sort=name', scrolled, 'sort'])
    expect(await page.textContent('p.searched')).toBe('Searched again')

    // Back to an entry of the same path keeps the focus where it was, as following the query did.
    await page.goBack()
    await page.locator('p.sorted', { hasText: 'Sorted none' }).waitFor()

    expect(await page.evaluate(() => document.activeElement?.className)).toBe('sort')
    expect(warnings).toEqual([])
  })

  it('keeps a query param typed by the page\'s schema, the server rendering it and its default leaving the URL plain', async () => {
    const warnings: string[] = []

    page.on('console', (message) => {
      if (message.type() === 'warning' || pageError(message))
        warnings.push(message.text())
    })

    const html = await (await page.request.get(`${origin}/paged?page=3&tags=a`)).text()

    expect(html).toContain('<script type="application/json" data-kay-query>')
    expect(html).toContain('Page <!--[-->3<!--]--> <!--[-->number<!--]--> <!--[-->a<!--]--> <!--[-->grid<!--]-->')

    await page.goto(`${origin}/paged?page=3&tags=a`)
    await page.click('button.next')
    await page.locator('p.paged', { hasText: 'Page 4 number a grid' }).waitFor()
    await page.click('button.tag')
    await page.click('button.list')
    await until(async () => page.evaluate(() => location.search === '?page=4&tags=a&tags=b&view=list'))
    await page.click('button.first')
    await until(async () => page.evaluate(() => location.search === '?tags=a&tags=b&view=list'))
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

  it('reveals the field a post was refused for when it is hidden until found, as find-in-page does', async () => {
    await page.goto(`${origin}/hidden`)
    await page.evaluate(() => {
      const matched: string[] = []

      ;(window as { matched?: string[] }).matched = matched
      document.addEventListener('beforematch', event => matched.push((event.target as Element).className))
      document.querySelector<HTMLInputElement>('input[name="code"]')!.value = 'ab'
    })
    await page.click('button.unchecked')
    await page.waitForFunction(() => document.activeElement?.getAttribute('name') === 'code')

    expect(await page.evaluate(() => (window as { matched?: string[] }).matched)).toEqual(['panel'])
    expect(await page.evaluate(() => document.querySelector('section.panel')!.hasAttribute('hidden'))).toBe(false)
    expect(await page.textContent('p.code-error')).toBe('Too short')
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

  it('brings the next page\'s inlined stylesheet with the swap and drops it again going back', async () => {
    const fresh = await browser.newPage()
    const rules = async () => fresh.evaluate(() => [...document.head.querySelectorAll('style')].filter(style => style.textContent.includes('.bar')).length)

    await fresh.goto(origin)
    await fresh.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
      document.body.insertAdjacentHTML('beforeend', '<a class="to-below" href="/below">Below</a>')
    })
    expect(await rules()).toBe(0)
    await fresh.click('a.to-below')
    await fresh.locator('h1', { hasText: 'Below' }).waitFor()

    expect(await rules()).toBe(1)
    expect(await fresh.evaluate(() => getComputedStyle(document.querySelector('.bar')!).position)).toBe('fixed')
    expect(await fresh.evaluate(() => (window as { kayAlive?: boolean }).kayAlive)).toBe(true)
    await fresh.goBack()
    await fresh.locator('h1', { hasText: 'Home' }).waitFor()

    expect(await rules()).toBe(0)
    await fresh.close()
  })

  it('swaps from a page linking its stylesheet to one inlining its own, and back', async () => {
    const fresh = await browser.newPage()
    const state = async () => fresh.evaluate(() => ({
      linked: document.head.querySelectorAll('link[rel="stylesheet"]').length,
      inlined: [...document.head.querySelectorAll('style')].filter(style => style.textContent.includes('.bar')).length,
    }))

    await fresh.goto(`${origin}/heavy`)
    await fresh.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
    })

    const before = await state()

    expect(before.linked).toBeGreaterThan(0)
    expect(before.inlined).toBe(0)
    await fresh.click('a.to-below')
    await fresh.locator('h1', { hasText: 'Below' }).waitFor()
    expect((await state()).inlined).toBe(1)
    expect(await fresh.evaluate(() => getComputedStyle(document.querySelector('.bar')!).position)).toBe('fixed')
    await fresh.goBack()
    await fresh.locator('h1', { hasText: 'Heavy' }).waitFor()

    expect(await state()).toEqual(before)
    expect(await fresh.evaluate(() => (window as { kayAlive?: boolean }).kayAlive)).toBe(true)
    await fresh.close()
  })

  it('swaps in the page a post redirects to, another one taking a history entry', async () => {
    const fresh = await browser.newPage()
    const alive = async () => fresh.evaluate(() => (window as { kayAlive?: boolean }).kayAlive === true)

    await fresh.goto(`${origin}/posted`)
    await fresh.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
    })
    await fresh.click('form.away button')
    await fresh.locator('h1', { hasText: 'Plain' }).waitFor()

    expect([new URL(fresh.url()).pathname, await alive()]).toEqual(['/plain', true])

    await fresh.goBack()
    await fresh.locator('h1', { hasText: 'Posted' }).waitFor()
    expect(await alive()).toBe(true)
    await fresh.close()
  })

  it('shows in place the error page a post is answered with, the address and the history kept', async () => {
    const fresh = await browser.newPage()

    await fresh.goto(`${origin}/posted`)
    await fresh.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
    })
    const entries = await fresh.evaluate(() => history.length)
    const answered = fresh.waitForResponse(response => response.request().method() === 'POST')

    await fresh.click('form.crash button')
    expect((await answered).status()).toBe(500)
    await fresh.waitForFunction(() => document.querySelector('form.crash') === null)

    expect(await fresh.evaluate(() => [location.pathname, history.length, (window as { kayAlive?: boolean }).kayAlive])).toEqual(['/posted', entries, true])
    await fresh.close()
  })

  it('shows how much of a form\'s upload went, on the form and its progress bars, then nothing once sent', async () => {
    const fresh = await browser.newPage()

    await fresh.goto(`${origin}/posted`)
    await fresh.setInputFiles('form.upload input', { name: 'big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(4 * 1024 * 1024) })
    await fresh.evaluate(() => {
      const form = document.querySelector<HTMLFormElement>('form.upload')!
      const seen: [string, number][] = []

      ;(window as { seen?: typeof seen }).seen = seen
      new MutationObserver(() => seen.push([form.style.getPropertyValue('--kay-progress'), form.querySelector('progress')!.value])).observe(form, { attributes: true, attributeFilter: ['style'] })
    })
    await fresh.click('form.upload button')
    await fresh.locator('p.sent', { hasText: `Sent ${4 * 1024 * 1024}` }).waitFor()

    const seen = await fresh.evaluate(() => (window as { seen?: [string, number][] }).seen!)
    const sent = seen.filter(([progress]) => progress !== '')

    expect(sent.length).toBeGreaterThan(0)
    expect(sent.at(-1)).toEqual(['1', 1])
    expect(sent.every(([progress, value]) => Number(progress) === value && value > 0 && value <= 1)).toBe(true)
    expect(seen.at(-1)![0]).toBe('')
    await fresh.close()
  })

  it('never posts a form again natively once the server had it, only the answer lost: the page loads and the action ran once', async () => {
    const fresh = await browser.newPage()
    const proxy = lossyProxy(Number(new URL(origin).port))

    try {
      await fresh.goto(`http://127.0.0.1:${proxy.port}/posted#top`)
      await fresh.evaluate(() => {
        (window as { kayAlive?: boolean }).kayAlive = true
      })
      await fresh.click('form.count button')
      await fresh.waitForFunction(() => (window as { kayAlive?: boolean }).kayAlive === undefined)
      await fresh.locator('p.posts').waitFor()
      await settled(fresh)

      expect(await fresh.locator('p.posts').textContent()).toBe('1')
    }
    finally {
      proxy.stop()
      await fresh.close()
    }
  })

  it('leaves a form to the browser when form posting cannot load', async () => {
    const fresh = await browser.newPage()

    await fresh.route(/\/forms-[^/]*\.js$/, async route => route.abort())
    await fresh.goto(`${origin}/posted`)
    await fresh.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
    })
    await fresh.click('form.away button')
    await fresh.locator('h1', { hasText: 'Plain' }).waitFor()

    expect(await fresh.evaluate(() => (window as { kayAlive?: boolean }).kayAlive)).toBeUndefined()
    await fresh.close()
  })

  it('shows the page of the last navigation started, one started earlier and answered later dropped', async () => {
    const fresh = await browser.newPage()

    await fresh.goto(`${origin}/plain`)
    const entries = await fresh.evaluate(() => history.length)

    // The earlier navigation's answer is held until the later one has shown its page.
    const { promise: held, resolve: release } = Promise.withResolvers<void>()

    await fresh.route(`${origin}/second`, async (route) => {
      await held
      await route.continue()
    })
    await fresh.click('a.second')
    await fresh.click('a.home')
    await fresh.locator('h1', { hasText: 'Home' }).waitFor()

    const answered = fresh.waitForResponse(`${origin}/second`)

    release()
    await answered
    await settled(fresh)

    expect(await fresh.evaluate(() => [location.pathname, document.querySelector('h1')!.textContent, history.length])).toEqual(['/', 'Home', entries + 1])
    await fresh.close()
  })

  it('focuses the main of a page without a heading', async () => {
    await page.goto(origin)
    await page.evaluate(() => {
      const link = Object.assign(document.createElement('a'), { href: '/contrast', className: 'contrast' })

      document.body.append(link)
      link.click()
    })
    await page.locator('button.faint').waitFor()

    expect(await page.evaluate(() => [document.activeElement?.tagName, document.activeElement?.getAttribute('tabindex')])).toEqual(['MAIN', '-1'])

    // Focusable only while focused, so a click inside it later draws no ring around it.
    await page.evaluate(() => (document.activeElement as HTMLElement).blur())

    expect(await page.evaluate(() => document.querySelector('main')!.hasAttribute('tabindex'))).toBe(false)
  })

  it('focuses a page\'s autofocus field when visited, and its heading on Back', async () => {
    const follow = async (href: string) => page.evaluate((to: string) => {
      const link = Object.assign(document.createElement('a'), { href: to })

      document.body.append(link)
      link.click()
    }, href)

    await page.goto(origin)
    await follow('/focused')
    await page.locator('h1', { hasText: 'Focused' }).waitFor()

    expect(await page.evaluate(() => document.activeElement?.className)).toBe('name')

    await follow('/contrast')
    await page.locator('button.faint').waitFor()
    await page.goBack()
    await page.locator('h1', { hasText: 'Focused' }).waitFor()

    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('H1')
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

  it('serves the pages it keeps and their islands offline after a first visit, the fallback for any other, and never kay\'s routes', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()

    await page.goto(origin)
    await page.waitForFunction(async () => (await navigator.serviceWorker.ready).active?.state === 'activated' && navigator.serviceWorker.controller !== null, undefined, { timeout: 10_000 })
    await page.goto(`${origin}/second`)
    await context.setOffline(true)

    try {
      await page.goto(origin)
      expect(await page.textContent('h1')).toBe('Home')

      // The page swap fetches the next page through the worker too.
      await page.evaluate(() => {
        (window as { kayAlive?: boolean }).kayAlive = true
      })
      await page.click('a.second')
      await page.locator('h1', { hasText: 'Second' }).waitFor()
      expect(await page.evaluate(() => (window as { kayAlive?: boolean }).kayAlive)).toBe(true)

      // Islands hydrate from the chunks it keeps.
      await page.click('button.player')
      await page.locator('button.player', { hasText: 'Played 1' }).waitFor()

      const fallback = await page.goto(`${origin}/plain`)

      expect(fallback?.status()).toBe(503)
      expect(await page.textContent('h1')).toBe('Offline')
      expect(await page.evaluate(async () => {
        try {
          await fetch('/_kay/health')

          return 'answered'
        }
        catch {
          return 'failed'
        }
      })).toBe('failed')
    }
    finally {
      await context.close()
    }
  }, 30_000)
})
