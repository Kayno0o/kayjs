import type { TestPage, TestSite } from '../src/test'
import process from 'node:process'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { PAGE_TIMEOUT_MS, TRANSITION_TIMEOUT_MS } from '../src/runtime/page-swap'
import { browserPath, testSite } from '../src/test'

const chrome = browserPath()
const NAVIGATE = 'x-kay-navigate'
const TRANSITION = '@view-transition { navigation: auto; } ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation-duration: 500ms; }'

interface Hold { test: (url: URL, request: Request) => boolean, gate: Promise<void>, release: () => void }

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(chrome === undefined && (process.env.CI ?? '') === '')('a refresh landing during a swap', () => {
  let site: TestSite
  const holds: Hold[] = []
  const seen: string[] = []

  // Holds the requests `test` matches until the returned function is called.
  function hold(test: Hold['test']): () => void {
    const { promise, resolve } = Promise.withResolvers<void>()

    holds.push({ test, gate: promise, release: resolve })

    return resolve
  }

  const isAction = (url: URL) => url.pathname.startsWith('/_kay/action')
  const isPage = (target: string) => (url: URL, request: Request) => request.headers.has(NAVIGATE) && url.pathname + url.search === target

  async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await condition())
        return

      await Bun.sleep(50)
    }

    throw new Error(`timed out waiting for ${what}`)
  }

  // Releases the held action and waits for its answer to reach the page. The refresh it starts loads a chunk before it asks for the page, which nothing shows from outside, hence the short wait.
  async function answered(page: TestPage, release: () => void): Promise<void> {
    release()
    await page.waitUntil(() => (window as { kayActions?: number }).kayActions! >= 1, { timeout: '5s' })
    await Bun.sleep(150)
  }

  // The page cannot be polled once it gave up and a full load is pending, and nothing shows from outside that it did: its shortened wait is waited out with a margin.
  const gaveUp = async (after: number) => Bun.sleep(after + 300)

  const requested = (match: (url: string) => boolean) => () => seen.some(match)

  beforeAll(async () => {
    const delays = new Elysia().onRequest(async ({ request }) => {
      const url = new URL(request.url)

      seen.push(`${request.method} ${url.pathname}${url.search}${request.headers.has(NAVIGATE) ? ' nav' : ''}`)

      for (const { test, gate } of holds) {
        if (test(url, request))
          await gate
      }

      return url.pathname === '/slow.css' ? new Response('h1 { color: red; }', { headers: { 'content-type': 'text/css' } }) : undefined
    })

    site = await testSite({ root: 'tests/fixtures/swap-refresh', use: [delays], browser: { path: chrome } })
  }, 120_000)

  afterEach(() => {
    // A request a test left held is answered, so no connection stays open.
    for (const { release } of holds)
      release()

    holds.length = 0
    seen.length = 0
  })

  afterAll(async () => site?.close())

  async function opened(transition: boolean): Promise<TestPage> {
    const page = await site.open('/')

    await page.waitFor('button.act')
    await page.evaluate(() => {
      const original = window.fetch.bind(window)
      const marked = window as { kayActions?: number }

      marked.kayActions = 0
      window.fetch = (async (...args: Parameters<typeof fetch>) => {
        const response = await original(...args)

        if (String(args[0] instanceof Request ? args[0].url : args[0]).includes('/_kay/action'))
          marked.kayActions!++

        return response
      }) as typeof fetch
    })

    if (transition) {
      await page.evaluate((css) => {
        const style = document.createElement('style')
        const start = document.startViewTransition.bind(document)
        const counted = window as { kayTransitions?: number }

        counted.kayTransitions = 0
        document.startViewTransition = ((update: () => void) => {
          counted.kayTransitions!++

          return start(update)
        }) as typeof document.startViewTransition
        style.textContent = css
        document.head.append(style)
      }, TRANSITION)
    }

    return page
  }

  const links = {
    query: { click: 'a.query', target: '/?view=b', path: '/?view=b', shows: ['p.view', 'b'] },
    cross: { click: 'a.cross', target: '/other', path: '/other', shows: ['h1', 'Other'] },
    // The same URL, which still adds the entry a click on a link does.
    self: { click: 'a.self', target: '/', path: '/', shows: ['h1', 'Home'] },
    tab: { click: 'button.tab', target: '/?view=tab', path: '/?view=tab', shows: ['p.view', 'tab'] },
  } as const

  for (const [name, link] of Object.entries(links)) {
    for (const order of ['before', 'after'] as const) {
      for (const transition of [false, true]) {
        it(`${name}: the swap of a click ${order === 'before' ? 'an action started before' : 'an action started after'} it arrives, ${transition ? 'in' : 'without'} a view transition`, async () => {
          await using page = await opened(transition)

          const entries = await page.evaluate(() => history.length)
          const releaseAction = hold(isAction)
          const releasePage = hold(isPage(link.target))
          const act = async () => {
            await page.click('button.act')
            await until(requested(url => url.startsWith('POST /_kay/action')), 'the action to be sent')
          }
          const follow = async () => {
            await page.click(link.click)
            await until(requested(url => url === `GET ${link.target} nav`), 'the page to be asked for')
          }

          if (order === 'before') {
            await act()
            await follow()
          }
          else {
            await follow()
            await act()
          }

          // The action answers while the page is still on its way, and its refresh starts.
          await answered(page, releaseAction)
          releasePage()
          await page.waitUntil((selector, text) => document.querySelector(selector)?.textContent === text && !document.documentElement.hasAttribute('aria-busy'), { timeout: '5s' }, ...link.shows)

          expect(await page.path()).toBe(link.path)
          expect(await page.evaluate(() => history.length)).toBe(entries + 1)

          if (transition)
            expect(await page.evaluate(() => (window as { kayTransitions?: number }).kayTransitions)).toBe(1)

          expect(page.errors).toEqual([])
        }, 30_000)
      }
    }
  }

  it('a link whose stylesheet is still loading arrives when an action refreshes meanwhile', async () => {
    await using page = await opened(false)

    const releaseSheet = hold(url => url.pathname === '/slow.css')
    const releaseAction = hold(isAction)

    await page.click('a.styled')
    await until(requested(url => url.startsWith('GET /slow.css')), 'the stylesheet to be asked for')
    await page.click('button.act')
    await until(requested(url => url.startsWith('POST /_kay/action')), 'the action to be sent')
    await answered(page, releaseAction)
    releaseSheet()
    await page.waitFor('h1', { text: 'Styled' })
    await page.waitUntil(() => !document.documentElement.hasAttribute('aria-busy'), { timeout: '5s' })

    expect(await page.path()).toBe('/styled')
    expect(page.errors).toEqual([])
  }, 30_000)

  it('a query link arrives when an action refreshes during its view transition', async () => {
    await using page = await opened(true)

    const releaseAction = hold(isAction)

    await page.click('button.act')
    await until(requested(url => url.startsWith('POST /_kay/action')), 'the action to be sent')
    await page.click('a.query')
    await page.waitUntil(() => document.documentElement.querySelector('p.view')?.textContent === 'b' && document.documentElement.hasAttribute('aria-busy'), { timeout: '5s' })
    releaseAction()
    await page.waitUntil(() => !document.documentElement.hasAttribute('aria-busy'), { timeout: '5s' })

    expect(await page.path()).toBe('/?view=b')
    expect(await page.text('p.view')).toBe('b')
    expect(page.errors).toEqual([])
  }, 30_000)

  // Makes the page's wait for a page or a transition last a moment, as a timer of exactly that length fires at once.
  async function shorten(page: TestPage, bounds: number[], to = 100): Promise<void> {
    await page.evaluate((lengths, to) => {
      const original = window.setTimeout.bind(window)

      // A timer of exactly one of these lengths fires after `to` instead.
      window.setTimeout = ((handler: TimerHandler, delay?: number, ...rest: unknown[]) => original(handler, delay !== undefined && lengths.includes(delay) ? to : delay, ...rest)) as typeof window.setTimeout
    }, bounds, to)
  }

  it('a link whose page never answers is loaded by the browser', async () => {
    await using page = await opened(false)

    await page.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
    })
    await shorten(page, [PAGE_TIMEOUT_MS])
    // The browser's own load waits behind the held fetch in its HTTP cache, so the server answers once the swap gave up: a swap still waiting would then show the page itself.
    const release = hold(isPage('/other'))

    await page.click('a.cross')
    await gaveUp(100)
    release()
    await page.waitFor('h1', { text: 'Other' })

    expect(await page.path()).toBe('/other')
    expect(await page.evaluate(() => (window as { kayAlive?: boolean }).kayAlive === true)).toBe(false)
    expect(page.errors).toEqual([])
  }, 30_000)

  it('a refresh waiting for a link that ends in a full load does not take the visitor back', async () => {
    await using page = await opened(false)

    // Long enough for the action's refresh to start waiting before the swap gives up.
    await shorten(page, [PAGE_TIMEOUT_MS], 800)

    const releaseAction = hold(isAction)
    const releasePage = hold(isPage('/?view=b'))

    await page.click('button.act')
    await until(requested(url => url.startsWith('POST /_kay/action')), 'the action to be sent')
    await page.click('a.query')
    await until(requested(url => url === 'GET /?view=b nav'), 'the page to be asked for')
    seen.length = 0
    await answered(page, releaseAction)
    await gaveUp(800)
    // The refresh, had it not given way, has asked for its page by now.
    await page.evaluate(() => 0)
    releasePage()
    await page.waitFor('p.view', { text: 'b' })

    expect(seen).not.toContain('GET / nav')
    expect(await page.path()).toBe('/?view=b')
    expect(page.errors).toEqual([])
  }, 30_000)

  it('a view transition that never finishes is skipped and the swap still commits', async () => {
    await using page = await opened(true)

    await shorten(page, [TRANSITION_TIMEOUT_MS])
    await page.evaluate(() => {
      const start = document.startViewTransition.bind(document)
      const counted = window as { kaySkipped?: number }

      counted.kaySkipped = 0
      document.startViewTransition = ((update: () => void) => {
        const real = start(update)

        return {
          finished: new Promise<void>(() => undefined),
          updateCallbackDone: real.updateCallbackDone,
          skipTransition: () => {
            counted.kaySkipped!++
            real.skipTransition()
          },
        }
      }) as unknown as typeof document.startViewTransition
    })
    await page.click('a.query')
    await page.waitUntil(() => document.querySelector('p.view')?.textContent === 'b' && !document.documentElement.hasAttribute('aria-busy'), { timeout: '5s' })

    expect(await page.evaluate(() => (window as { kaySkipped?: number }).kaySkipped)).toBe(1)
    expect(page.errors).toEqual([])
  }, 30_000)

  it('a link pressed during the view transition of another is followed', async () => {
    await using page = await opened(true)

    await page.evaluate(() => {
      const style = document.createElement('style')

      // The animation outlasts the click.
      style.textContent = '::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation-duration: 3s !important; }'
      document.head.append(style)
    })
    await page.click('a.cross')
    await page.waitFor('h1', { text: 'Other' })

    const running = await page.evaluate(() => document.getAnimations().some(animation => (animation.effect as KeyframeEffect | null)?.pseudoElement?.startsWith('::view-transition')))
    const [x, y] = await page.evaluate(() => {
      const box = document.querySelector('a.home')!.getBoundingClientRect()

      return [box.x + box.width / 2, box.y + box.height / 2]
    })

    // A press as a pointer makes it, not the page's own click().
    await page.view.click(x, y)
    await page.waitFor('h1', { text: 'Home', timeout: '3s' })

    expect(running).toBe(true)
    expect(await page.path()).toBe('/')
    expect(page.errors).toEqual([])
  }, 30_000)

  it('overlapping view transitions leave one click listener on the document, and none once they end', async () => {
    await using page = await opened(true)

    await page.evaluate(() => {
      const add = document.addEventListener.bind(document)
      const remove = document.removeEventListener.bind(document)
      const start = document.startViewTransition.bind(document)
      const held = window as { kayLive?: Set<unknown>, kayPeak?: number, kayEnd?: () => void }
      const live = new Set<unknown>()
      const ends: (() => void)[] = []

      held.kayLive = live
      held.kayPeak = 0
      held.kayEnd = () => {
        for (const end of ends.splice(0)) {
          end()
        }
      }
      document.addEventListener = ((type: string, listener: unknown, ...rest: unknown[]) => {
        if (type === 'click') {
          live.add(listener)
          held.kayPeak = Math.max(held.kayPeak!, live.size)
        }

        return (add as (...args: unknown[]) => void)(type, listener, ...rest)
      }) as typeof document.addEventListener
      document.removeEventListener = ((type: string, listener: unknown, ...rest: unknown[]) => {
        if (type === 'click')
          live.delete(listener)

        return (remove as (...args: unknown[]) => void)(type, listener, ...rest)
      }) as typeof document.removeEventListener
      // Each transition finishes only when kayEnd says so.
      document.startViewTransition = ((update: () => void) => {
        const real = start(update)
        const gate = new Promise<void>((resolve) => {
          ends.push(resolve)
        })

        return { finished: gate, updateCallbackDone: real.updateCallbackDone, skipTransition: () => real.skipTransition() }
      }) as unknown as typeof document.startViewTransition
    })
    await page.click('a.cross')
    await page.waitFor('h1', { text: 'Other' })
    await page.click('a.home')
    await page.waitFor('h1', { text: 'Home' })

    const state = async () => page.evaluate(() => {
      const held = window as { kayLive?: Set<unknown>, kayPeak?: number }

      return { live: held.kayLive!.size, peak: held.kayPeak! }
    })
    const overlapping = await state()

    await page.evaluate(() => (window as { kayEnd?: () => void }).kayEnd!())
    await page.waitUntil(() => !document.documentElement.hasAttribute('aria-busy'), { timeout: '5s' })

    const ended = await state()

    // A click after the end is the eager listener's alone, none of the transitions'.
    await page.click('a.cross')
    await page.waitFor('h1', { text: 'Other' })
    await page.evaluate(() => (window as { kayEnd?: () => void }).kayEnd!())
    await page.waitUntil(() => !document.documentElement.hasAttribute('aria-busy'), { timeout: '5s' })

    expect(overlapping.live).toBe(1)
    expect(overlapping.peak).toBe(1)
    expect(ended.live).toBe(0)
    expect(await state()).toEqual({ live: 0, peak: 1 })
    expect(await page.path()).toBe('/other')
    expect(page.errors).toEqual([])
  }, 30_000)

  it('back arrives on the page it goes to when an action refreshes during it', async () => {
    await using page = await opened(false)

    await page.click('a.cross')
    await page.waitFor('h1', { text: 'Other' })
    await page.click('a.home')
    await page.waitFor('h1', { text: 'Home' })

    const releaseAction = hold(isAction)
    const releasePage = hold(isPage('/other'))

    await page.click('button.act')
    await until(requested(url => url.startsWith('POST /_kay/action')), 'the action to be sent')
    await page.evaluate(() => {
      history.back()
    })
    await until(requested(url => url === 'GET /other nav'), 'the page to be asked for')
    await answered(page, releaseAction)
    releasePage()
    await page.waitFor('h1', { text: 'Other' })
    await page.waitUntil(() => !document.documentElement.hasAttribute('aria-busy'), { timeout: '5s' })

    expect(await page.path()).toBe('/other')
    expect(page.errors).toEqual([])
  }, 30_000)

  it('forward arrives on the page it goes to when an action refreshes during it', async () => {
    await using page = await opened(false)

    await page.click('a.cross')
    await page.waitFor('h1', { text: 'Other' })
    await page.evaluate(() => {
      history.back()
    })
    await page.waitFor('h1', { text: 'Home' })

    const releaseAction = hold(isAction)
    const releasePage = hold(isPage('/other'))

    await page.click('button.act')
    await until(requested(url => url.startsWith('POST /_kay/action')), 'the action to be sent')
    await page.evaluate(() => {
      history.forward()
    })
    await until(requested(url => url === 'GET /other nav'), 'the page to be asked for')
    await answered(page, releaseAction)
    releasePage()
    await page.waitFor('h1', { text: 'Other' })

    expect(await page.path()).toBe('/other')
    expect(page.errors).toEqual([])
  }, 30_000)
})
