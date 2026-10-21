import type { TestPage } from '../src/test'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { browse, browserPath } from '../src/test'
import { scratchDir } from './scratch'

const LISTENING = /port (\d+)/
// CI installs Chromium and names it in BUN_CHROME_PATH, where a missing browser fails rather than skipping.
const browserInstalled = browserPath() !== undefined
// The size Playwright opened pages with, which the scroll and layout tests were written for.
const VIEWPORT = { width: 1280, height: 720 }

type Fixture = Bun.Subprocess<'ignore', 'pipe', 'pipe'>

let server: Fixture
let page: TestPage
let origin: string

async function listeningPort(child: Fixture): Promise<string> {
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

// A server of the navigation fixture on a port of its own, and the origin it answers on.
async function startFixture(): Promise<{ server: Fixture, origin: string }> {
  const started: Fixture = Bun.spawn(['bun', 'tests/fixtures/navigation/server.ts'], { env: { ...process.env, NODE_ENV: 'production' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })

  return { server: started, origin: `http://localhost:${await listeningPort(started)}` }
}

// A page of the fixture, opened at the size the suite was written for.
async function open(path: string, options: Parameters<typeof browse>[1] = {}): Promise<TestPage> {
  return browse(`${origin}${path}`, { ...VIEWPORT, ...options })
}

// Forwards to the fixture, the answer to the first action post cut off by closing the connection short of the body it promised once the server has run it.
function lossyProxy(target: number, mode: 'cut-answer' | 'reset-request' = 'cut-answer') {
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
        if (mode === 'reset-request' && new TextDecoder().decode(chunk.subarray(0, 24)).startsWith('POST /_kay/action')) {
          client.terminate()

          return
        }

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
async function sameDocument(on: TestPage = page): Promise<boolean> {
  return on.evaluate(() => (window as { kayAlive?: boolean }).kayAlive === true)
}

async function until(holds: () => boolean | Promise<boolean>): Promise<void> {
  while (!await holds())
    await Bun.sleep(20)
}

// Whatever the page had queued after its load or its last event has run: two frames and a task later, for a test asserting something did not happen.
async function settled(on: TestPage): Promise<void> {
  await on.evaluate(async () => new Promise<void>((resolve) => {
    // A page in the background gets no frames, so a timer ends the wait too.
    setTimeout(resolve, 100)
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve)))
  }))
}

// Whether the page loaded the chunk of that name, such as `prefetch` for `prefetch-<hash>.js`.
async function chunkLoaded(on: TestPage, name: string): Promise<boolean> {
  return on.evaluate((chunk: string) => performance.getEntriesByType('resource').some(entry => new RegExp(`/${chunk}-[^/]*\\.js$`).test(entry.name)), name)
}

// What the page logged as a warning or an error from now on, read back later.
function problems(on: TestPage): () => string[] {
  const from = { warnings: on.warnings.length, errors: on.errors.length }

  return () => [...on.warnings.slice(from.warnings), ...on.errors.slice(from.errors)]
}

async function addStyle(on: TestPage, css: string): Promise<void> {
  await on.evaluate((content: string) => {
    const style = document.createElement('style')

    style.textContent = content
    document.head.append(style)
  }, css)
}

// What a path of the site answers the page itself, as it asks with the cookies it holds.
async function fetchText(on: TestPage, path: string): Promise<string> {
  return on.evaluate(async (to: string) => (await fetch(to)).text(), path)
}

// A press of the primary button on the element, the pointer moved onto it first.
async function pressOn(on: TestPage, selector: string): Promise<void> {
  const [x, y] = await on.evaluate((target: string) => {
    const { left, top, width, height } = document.querySelector(target)!.getBoundingClientRect()

    return [left + width / 2, top + height / 2]
  }, selector)

  await on.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
}

// A file of the given size to upload.
async function bigFile(): Promise<string> {
  const file = join(await scratchDir('upload-'), 'big.bin')

  await Bun.write(file, new Uint8Array(4 * 1024 * 1024))

  return file
}

describe.skipIf(!browserInstalled && (process.env.CI ?? '') === '')('page swap in Chromium', () => {
  beforeAll(async () => {
    ({ server, origin } = await startFixture())
    page = await open('/')
  }, 60_000)

  afterAll(async () => {
    page?.close()
    server?.kill()
    await server?.exited
  })

  it('swaps the next page in, a persistent island keeping its state and its element', async () => {
    const problem = problems(page)

    await page.goto(origin)
    await page.click('button.player')
    await page.click('button.player')
    await page.waitFor('button.player', { text: 'Played 2' })
    expect(await page.text('button.page-note')).toBe('/')
    await page.click('button.page-note')
    expect(await page.text('button.page-note')).toBe('edited')
    await page.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
      ;(document.querySelector('slot[data-persist]') as HTMLElement & { kayMark?: string }).kayMark = 'kept'
    })
    page.responses.length = 0

    const fetched = () => page.responses.filter(({ url }) => new URL(url).pathname === '/second').map(({ method }) => method)
    const hovered = page.waitForResponse('/second')

    // The default rules load nothing more at start: the prefetch code comes with the first link pointed at, which it prefetches too.
    expect(await chunkLoaded(page, 'prefetch')).toBe(false)
    await page.hover('a.second')
    await hovered
    await page.click('a.second')
    await page.waitFor('h1', { text: 'Second' })

    expect(await sameDocument()).toBe(true)
    expect(await page.path()).toBe('/second')
    expect(await page.evaluate(() => document.title)).toBe('Second')
    // Fetched once, when hovered: the swap took that response rather than asking again, and the browser's own prefetch was off.
    expect(fetched()).toEqual(['GET'])
    expect(await page.count('script[type="speculationrules"]')).toBe(0)
    expect(await chunkLoaded(page, 'prefetch')).toBe(true)
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('h1')!).color)).toBe('rgb(1, 2, 3)')
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('H1')
    expect(await page.text('button.player')).toBe('Played 2')
    expect(await page.evaluate(() => (document.querySelector('slot[data-persist]') as HTMLElement & { kayMark?: string }).kayMark)).toBe('kept')
    // Kept, it takes the props the new page gives it, and the note edited over the old ones follows them.
    expect(await page.text('button.page-note')).toBe('/second')
    await page.click('button.player')
    expect(await page.text('button.player')).toBe('Played 3')
    // Back on the first page, the edit made there is long out of date.
    await page.click('a.home')
    await page.waitUntil(() => (/^\/$/).test(document.querySelector('button.page-note')?.textContent ?? ''))
    expect(await page.text('button.page-note')).toBe('/')
    expect(await page.text('button.player')).toBe('Played 3')
    await page.click('a.second')
    await page.waitFor('h1', { text: 'Second' })
    expect(problem()).toEqual([])
  })

  // The home page with its speculation rules rewritten to another eagerness, or dropped, hovered or pressed on its second link.
  async function prefetching(eagerness: string | undefined, act: (on: TestPage) => Promise<void>): Promise<{ fetched: string[], loaded: boolean }> {
    const fresh = await open('/')

    try {
      await fresh.route(`${origin}/`, async (request) => {
        const response = await request.fetch()
        const html = response.text()

        await request.fulfill({ status: response.status, headers: response.headers, body: eagerness === undefined ? html.replace(/<script type="speculationrules">.*?<\/script>/, '') : html.replace('"eagerness":"moderate"', `"eagerness":"${eagerness}"`) })
      })
      await fresh.goto(origin)
      fresh.responses.length = 0
      await act(fresh)
      await settled(fresh)
      await Bun.sleep(500)

      return { fetched: fresh.responses.filter(({ url }) => new URL(url).pathname === '/second').map(({ method }) => method), loaded: await chunkLoaded(fresh, 'prefetch') }
    }
    finally {
      fresh.close()
    }
  }

  // A refresh keeps the focus where it was, which a link followed moves to the new page's heading.
  async function refreshed(on: TestPage): Promise<void> {
    const before = await on.text('p.bumps')

    await on.evaluate(() => document.querySelector<HTMLElement>('button.bump')!.click())
    await on.waitUntil((text: string | null) => document.querySelector('p.bumps')!.textContent !== text, {}, before)
  }

  // A browser without `moveBefore`, whose swap puts nodes back with `insertBefore`.
  async function withoutMoveBefore(on: TestPage): Promise<void> {
    await on.initScript(() => {
      for (const prototype of [Element.prototype, Document.prototype, DocumentFragment.prototype])
        Reflect.deleteProperty(prototype, 'moveBefore')
    })
  }

  describe('scrolled panels of the persistent island', () => {
    // Each as [top, left].
    const SCROLLS = { outer: [300, 40], inner: [120, 25] }

    // A panel scrolled both ways with another scrolled in it, and a field in the inner one holding the focus.
    async function scrolledInIsland(on: TestPage, smooth = false): Promise<void> {
      await on.evaluate(([scrolls, behavior]: [typeof SCROLLS, string]) => {
        const island = document.querySelector('slot[data-persist]')!
        const outer = document.createElement('div')
        const inner = document.createElement('div')
        const input = document.createElement('input')

        outer.className = 'outer'
        outer.setAttribute('style', `display: block; width: 200px; height: 100px; overflow: auto; scroll-behavior: ${behavior}`)
        inner.className = 'inner'
        inner.setAttribute('style', `width: 400px; height: 60px; overflow: auto; margin: 4px; scroll-behavior: ${behavior}`)
        input.setAttribute('aria-label', 'inside')

        const wide = document.createElement('div')
        const filler = document.createElement('div')

        wide.setAttribute('style', 'width: 1200px; height: 600px')
        filler.setAttribute('style', 'width: 900px; height: 500px')
        inner.append(filler, input)
        outer.append(inner, wide)
        island.append(outer)
        outer.scrollTo(scrolls.outer[1]!, scrolls.outer[0]!)
        inner.scrollTo(scrolls.inner[1]!, scrolls.inner[0]!)
      }, [SCROLLS, smooth ? 'smooth' : 'auto'] as [typeof SCROLLS, string])
      // A smooth scroll to its place takes a moment.
      await on.waitUntil((expected: typeof SCROLLS) => {
        const outer = document.querySelector('.outer')!
        const inner = document.querySelector('.inner')!

        return outer.scrollTop === expected.outer[0] && inner.scrollTop === expected.inner[0]
      }, {}, SCROLLS)
    }

    async function scrollsOf(on: TestPage): Promise<{ outer: number[], inner: number[], focused: boolean }> {
      return on.evaluate(() => {
        const outer = document.querySelector('.outer')!
        const inner = document.querySelector('.inner')!

        return { outer: [outer.scrollTop, outer.scrollLeft], inner: [inner.scrollTop, inner.scrollLeft], focused: document.activeElement?.getAttribute('aria-label') === 'inside' }
      })
    }

    for (const moving of [true, false]) {
      describe(moving ? 'with moveBefore' : 'without moveBefore', () => {
        let fresh: TestPage

        // One page for the tests of a mode, loaded afresh by each: every page a test opens is a tab the later tests of this file pay for.
        beforeAll(async () => {
          fresh = await open('/')

          if (!moving)
            await withoutMoveBefore(fresh)
        })

        beforeEach(async () => {
          await fresh.goto(origin)
        })

        afterAll(() => {
          fresh.close()
        })

        it('keeps the scroll of a panel and of one nested in it, both ways, through a refresh', async () => {
          await scrolledInIsland(fresh)
          await refreshed(fresh)

          expect(await scrollsOf(fresh)).toEqual({ ...SCROLLS, focused: false })
          expect(fresh.errors).toEqual([])
        })

        it('keeps them through a link followed and Back, in the same element', async () => {
          await scrolledInIsland(fresh)
          await fresh.evaluate(() => {
            document.querySelector('.inner')!.id = 'same'
          })
          await fresh.evaluate(() => document.querySelector<HTMLElement>('a.second')!.click())
          await fresh.waitFor('h1', { text: 'Second' })

          expect(await scrollsOf(fresh)).toEqual({ ...SCROLLS, focused: false })
          expect(await fresh.count('#same')).toBe(1)
          await fresh.back()
          await fresh.waitFor('h1', { text: 'Home' })

          expect(await scrollsOf(fresh)).toEqual({ ...SCROLLS, focused: false })
          expect(fresh.errors).toEqual([])
        })

        it('puts a panel with smooth scrolling back at once', async () => {
          await scrolledInIsland(fresh, true)
          await refreshed(fresh)

          // Read in the frame after the swap, before a smooth scroll from the top could have reached its place.
          expect(await scrollsOf(fresh)).toEqual({ ...SCROLLS, focused: false })
        })

        it('keeps the focus in a field of the panel and the scroll of the panel around it', async () => {
          await scrolledInIsland(fresh)
          await fresh.evaluate(() => document.querySelector<HTMLInputElement>('[aria-label="inside"]')!.focus({ preventScroll: true }))
          await refreshed(fresh)

          expect(await scrollsOf(fresh)).toEqual({ ...SCROLLS, focused: true })
        })

        it('reads no scroll from the page when the next page keeps no island', async () => {
          await scrolledInIsland(fresh)
          await fresh.evaluate(() => {
            const read = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')! as { get: () => number, set: (value: number) => void }
            const state = window as { kayScrollReads?: number }
            const link = Object.assign(document.createElement('a'), { href: '/bare', className: 'bare' })

            state.kayScrollReads = 0
            Object.defineProperty(Element.prototype, 'scrollTop', {
              configurable: true,
              get() {
                state.kayScrollReads!++

                return read.get.call(this)
              },
              set(value: number) {
                read.set.call(this, value)
              },
            })
            document.querySelector('nav')!.append(link)
            link.click()
          })
          await fresh.waitFor('h1', { text: 'Bare' })

          expect(await fresh.count('slot[data-persist]')).toBe(0)
          expect(await fresh.evaluate(() => (window as { kayScrollReads?: number }).kayScrollReads)).toBe(0)
        })
      })
    }
  })

  // A page of its own, as the tests after these count on the document and the history the shared page holds.
  describe('nodes moved in place', () => {
    let own: TestPage

    beforeEach(async () => {
      own = await open('/')
    })

    afterEach(() => {
      own.close()
    })

    // An iframe, a field holding the focus with a selection, and an open popover put into the persistent island, whose state a move through insertBefore resets.
    async function stateInIsland(on: TestPage): Promise<void> {
      await on.evaluate(() => {
        const state = window as { kayFocusIns?: number, kayLoads?: number }
        const island = document.querySelector('slot[data-persist]')!
        const frame = document.createElement('iframe')

        frame.src = 'about:blank'
        island.append(frame)
        ;(frame.contentWindow as Window & { kayMark?: string }).kayMark = 'loaded'
        state.kayLoads = 0
        frame.addEventListener('load', () => {
          state.kayLoads!++
        })

        const input = document.createElement('input')

        input.value = 'typed here'
        input.setAttribute('aria-label', 'held')
        island.append(input)
        state.kayFocusIns = 0
        input.addEventListener('focusin', () => {
          state.kayFocusIns!++
        })
        input.focus()
        input.setSelectionRange(2, 4)

        const menu = document.createElement('div')

        menu.setAttribute('popover', '')
        menu.id = 'menu'
        island.append(menu)
        menu.showPopover()
      })
    }

    async function islandState(on: TestPage): Promise<{ mark: string | undefined, loads: number | undefined, focused: boolean, selection: number[], focusIns: number | undefined, menuOpen: boolean }> {
      return on.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>('slot[data-persist] input')!

        return {
          mark: (document.querySelector<HTMLIFrameElement>('slot[data-persist] iframe')!.contentWindow as Window & { kayMark?: string }).kayMark,
          loads: (window as { kayLoads?: number }).kayLoads,
          focused: document.activeElement === input,
          selection: [input.selectionStart!, input.selectionEnd!],
          focusIns: (window as { kayFocusIns?: number }).kayFocusIns,
          menuOpen: document.querySelector('#menu')!.matches(':popover-open'),
        }
      })
    }

    it('moves the persistent island in place, its iframe loaded and its field focused, and still closes a popover left open', async () => {
      await stateInIsland(own)
      await refreshed(own)

      // No focus event after the first: the field was never taken out, so nothing had to give the focus back.
      expect(await islandState(own)).toEqual({ mark: 'loaded', loads: 0, focused: true, selection: [2, 4], focusIns: 1, menuOpen: false })
    })

    it('places the persistent island where a wrapper of the next page puts it, keeping its state', async () => {
      await stateInIsland(own)
      await own.evaluate(() => document.querySelector<HTMLElement>('a.second')!.click())
      await own.waitFor('h1', { text: 'Second' })
      await own.evaluate(() => {
        const link = document.createElement('a')

        link.href = '/wrapped'
        link.className = 'wrapped'
        link.textContent = 'Wrapped'
        document.querySelector('nav')!.append(link)
      })
      await own.evaluate(() => document.querySelector<HTMLElement>('a.wrapped')!.click())
      await own.waitFor('h1', { text: 'Wrapped' })

      expect(await own.count('section.wrapper > slot[data-persist]')).toBe(1)
      expect(await own.count('slot[data-persist]')).toBe(1)
      expect(await islandState(own)).toMatchObject({ mark: 'loaded', menuOpen: false })
      expect(await own.evaluate(() => document.documentElement.lastElementChild === document.body)).toBe(true)
    })

    it('swaps on a browser without moveBefore, the focus given back to the field the island took with it', async () => {
      const fresh = await open('/')

      try {
        await withoutMoveBefore(fresh)
        await fresh.goto(origin)
        await stateInIsland(fresh)
        await refreshed(fresh)

        const state = await islandState(fresh)

        expect(state).toMatchObject({ focused: true, selection: [2, 4], menuOpen: false })
        // Taken out and put back once, the field lost the focus and the swap gave it back, the iframe loading once more.
        expect(state.focusIns).toBe(2)
        expect(state.loads).toBe(1)
        expect(fresh.errors).toEqual([])
      }
      finally {
        fresh.close()
      }
    })

    describe('rows moved in a keyed list', () => {
      const MOVES: Record<string, (rows: string[]) => string[]> = {
        'to-end': rows => [...rows.slice(1), rows[0]!],
        'to-front': rows => [rows.at(-1)!, ...rows.slice(0, -1)],
        'swap': rows => [rows[1]!, rows[0]!, ...rows.slice(2)],
        'reverse': rows => [...rows].reverse(),
      }

      async function rowsOf(on: TestPage): Promise<string[]> {
        return on.evaluate(() => [...document.querySelectorAll('ul.rows > li.row')].map(row => (row as HTMLElement).dataset.id!))
      }

      async function subsOf(on: TestPage, id: string): Promise<string[]> {
        return on.evaluate((row: string) => [...document.querySelectorAll(`li.row[data-id="${row}"] li.sub`)].map(sub => (sub as HTMLElement).dataset.id!), id)
      }

      // What each row's iframe still holds from before the move, in the order the rows are in.
      async function marks(on: TestPage): Promise<string[]> {
        return on.evaluate(() => [...document.querySelectorAll<HTMLIFrameElement>('li.row > iframe')].map(frame => (frame.contentWindow as Window & { kayMark?: string }).kayMark ?? 'lost'))
      }

      async function opened(on: TestPage): Promise<void> {
        await on.goto('/reorder')
        await on.waitFor('button.to-end')
        await on.evaluate(() => {
          for (const frame of document.querySelectorAll<HTMLIFrameElement>('li.row > iframe'))
            (frame.contentWindow as Window & { kayMark?: string }).kayMark = frame.title
        })
      }

      // The field takes the focus and the button is pressed by script, as a click would take the focus to the button.
      async function move(on: TestPage, button: string, focus: string): Promise<void> {
        await on.evaluate(([name, target]: [string, string]) => {
          document.querySelector<HTMLInputElement>(`[aria-label="${target}"]`)!.focus()
          document.querySelector<HTMLElement>(`button.${name}`)!.click()
        }, [button, focus] as [string, string])
      }

      async function focused(on: TestPage): Promise<string | null> {
        return on.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null)
      }

      for (const [name, order] of Object.entries(MOVES)) {
        it(`keeps the iframe and the focus of every row when the list goes ${name}`, async () => {
          await opened(own)

          for (const target of ['a', 'b', 'c', 'd']) {
            const before = await rowsOf(own)

            await move(own, name, target)

            expect(await rowsOf(own)).toEqual(order(before))
            expect(await focused(own)).toBe(target)
            expect(await marks(own)).toEqual(order(before))
          }

          expect(own.errors).toEqual([])
        })
      }

      it('moves a row of several nodes whole, its iframe loaded and its field focused', async () => {
        await opened(own)
        await own.evaluate(() => {
          for (const frame of document.querySelectorAll<HTMLIFrameElement>('dd.def > iframe'))
            (frame.contentWindow as Window & { kayMark?: string }).kayMark = frame.title
        })

        let rows = ['a', 'b', 'c', 'd']

        for (const [name, order] of Object.entries(MOVES)) {
          for (const target of rows) {
            await move(own, name, `def-${target}`)
            rows = order(rows)

            expect(await own.evaluate(() => [...document.querySelectorAll('dl.defs > *')].map(node => `${node.localName}:${(node as HTMLElement).dataset.id}`))).toEqual(rows.flatMap(id => [`dt:${id}`, `dd:${id}`]))
            expect(await focused(own)).toBe(`def-${target}`)
            expect(await own.evaluate(() => [...document.querySelectorAll<HTMLIFrameElement>('dd.def > iframe')].map(frame => (frame.contentWindow as Window & { kayMark?: string }).kayMark ?? 'lost'))).toEqual(rows.map(id => `def-${id}`))
          }
        }
      })

      it('keeps the focus of a row of a nested list moved inside its row', async () => {
        await opened(own)
        await move(own, 'nested', 'b2')

        expect(await subsOf(own, 'b')).toEqual(['b2', 'b3', 'b1'])
        expect(await focused(own)).toBe('b2')
        await move(own, 'nested', 'b1')

        expect(await subsOf(own, 'b')).toEqual(['b3', 'b1', 'b2'])
        expect(await focused(own)).toBe('b1')
        expect(await marks(own)).toEqual(['a', 'b', 'c', 'd'])
      })

      it('moves the rows of a list that is out of the document, and they are in place once it is back', async () => {
        await opened(own)
        await own.evaluate(() => {
          const rows = document.querySelector('ul.rows')!
          const anchor = rows.parentNode!.insertBefore(document.createComment(''), rows)

          rows.remove()
          document.querySelector<HTMLElement>('button.to-end')!.click()
          document.querySelector<HTMLElement>('button.swap')!.click()
          anchor.parentNode!.insertBefore(rows, anchor)
        })

        expect(await rowsOf(own)).toEqual(['c', 'b', 'd', 'a'])
        expect(own.errors).toEqual([])
      })

      it('puts the rows in order on a browser without moveBefore', async () => {
        const fresh = await open('/')

        try {
          await withoutMoveBefore(fresh)
          await opened(fresh)

          let rows = ['a', 'b', 'c', 'd']

          for (const [name, order] of Object.entries(MOVES)) {
            await move(fresh, name, 'a')
            rows = order(rows)

            expect(await rowsOf(fresh)).toEqual(rows)
          }

          expect(fresh.errors).toEqual([])
        }
        finally {
          fresh.close()
        }
      })
    })
  })

  it('loads no prefetch code on a page without speculation rules, and fetches nothing when a link is hovered', async () => {
    expect(await prefetching(undefined, async on => on.hover('a.second'))).toEqual({ fetched: [], loaded: false })
  })

  it('prefetches the first link hovered under eager rules, and the first pressed under conservative ones, hovering alone fetching nothing there', async () => {
    expect(await prefetching('eager', async on => on.hover('a.second'))).toEqual({ fetched: ['GET'], loaded: true })
    expect(await prefetching('conservative', async on => on.hover('a.second'))).toEqual({ fetched: [], loaded: true })
    expect(await prefetching('conservative', async (on) => {
      await on.hover('a.second')
      await pressOn(on, 'a.second')
    })).toEqual({ fetched: ['GET'], loaded: true })
  })

  it('loads the form checks once a form is used, and checks a form submitted before they loaded', async () => {
    const fresh = await open('/second')

    try {
      await fresh.waitFor('form')
      await settled(fresh)

      expect(await chunkLoaded(fresh, 'validate')).toBe(false)

      await fresh.evaluate(() => {
        document.querySelector<HTMLInputElement>('input[name="title"]')!.value = 'ab'
        document.querySelector('form')!.requestSubmit()
      })
      await fresh.waitUntil(() => document.querySelector('input')!.validationMessage === 'Too short')

      expect(await chunkLoaded(fresh, 'validate')).toBe(true)
      expect(await fresh.count('p.error, p.done')).toBe(0)
    }
    finally {
      fresh.close()
    }
  })

  it('loads the swap once a link is pointed at or followed, and swaps a link clicked before it loaded', async () => {
    const fresh = await open('/')

    try {
      await settled(fresh)

      expect(await chunkLoaded(fresh, 'page-swap')).toBe(false)

      // A click with no pointer before it, as a keyboard or a script makes.
      await fresh.evaluate(() => {
        (window as { kayAlive?: boolean }).kayAlive = true
        document.querySelector<HTMLAnchorElement>('a.second')!.click()
      })
      await fresh.waitFor('h1', { text: 'Second' })

      expect(await sameDocument(fresh)).toBe(true)
      expect(await chunkLoaded(fresh, 'page-swap')).toBe(true)
    }
    finally {
      fresh.close()
    }
  })

  it('cancels the fetch of a navigation a newer one took over, and loads nothing for it', async () => {
    const fresh = await open('/')

    try {
      await settled(fresh)
      await fresh.evaluate(() => {
        const holder = window as { kayAlive?: boolean, kayAborted?: boolean }
        const real = window.fetch.bind(window)

        holder.kayAlive = true
        // The first page hangs until the navigation fetching it is cancelled.
        window.fetch = (async (input, init) => {
          if (!String(input).endsWith('/later'))
            return real(input, init)

          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () => {
              holder.kayAborted = true
              reject(new DOMException('aborted', 'AbortError'))
            })
          })
        }) as typeof fetch
        document.querySelector<HTMLAnchorElement>('a.later')!.click()
      })
      await settled(fresh)
      await fresh.evaluate(() => document.querySelector<HTMLAnchorElement>('a.second')!.click())
      await fresh.waitFor('h1', { text: 'Second' })

      expect(await fresh.evaluate(() => (window as { kayAborted?: boolean }).kayAborted)).toBe(true)
      expect(await sameDocument(fresh)).toBe(true)
      expect(await fresh.path()).toBe('/second')
    }
    finally {
      fresh.close()
    }
  })

  it('loads the next page fully when the swap cannot load', async () => {
    const fresh = await open('/')

    try {
      await fresh.route(/\/page-swap-[^/]*\.js$/, async request => request.abort())
      await fresh.goto(origin)
      await fresh.evaluate(() => {
        (window as { kayAlive?: boolean }).kayAlive = true
      })
      await fresh.click('a.second')
      await fresh.waitFor('h1', { text: 'Second' })

      expect(await fresh.evaluate(() => (window as { kayAlive?: boolean }).kayAlive)).toBeUndefined()
      expect(await fresh.path()).toBe('/second')
    }
    finally {
      fresh.close()
    }
  })

  it('reloads the page in its own history entry on a refresh when the swap cannot load', async () => {
    const fresh = await open('/')

    try {
      await fresh.route(/\/page-swap-[^/]*\.js$/, async request => request.abort())
      await fresh.goto(origin)
      await fresh.evaluate(() => {
        (window as { kayAlive?: boolean }).kayAlive = true
      })

      const entries = await fresh.evaluate(() => history.length)

      await fresh.click('button.bump')
      await fresh.waitUntil(() => (window as { kayAlive?: boolean }).kayAlive === undefined && document.readyState === 'complete')

      expect(await fresh.evaluate(() => [location.pathname, history.length])).toEqual(['/', entries])
    }
    finally {
      fresh.close()
    }
  })

  it('leaves a form to the server when its checks cannot load, reporting no error', async () => {
    const fresh = await open('/second')

    try {
      await fresh.route(/\/validate-[^/]*\.js$/, async request => request.abort())
      await fresh.goto('/second')
      fresh.responses.length = 0
      await fresh.fill('input[name="title"]', 'ab')

      const answered = fresh.waitForResponse('/_kay/action/*')

      await fresh.click('form button')
      await answered

      // Sent unchecked for the server to refuse, the failed load reported to no one.
      expect(fresh.responses.filter(({ method }) => method === 'POST').map(({ url }) => new URL(url).pathname.replace(/\/_kay\/action\/.*/, '/_kay/action'))).toEqual(['/_kay/action'])
    }
    finally {
      fresh.close()
    }
  })

  it('posts a form without a reload, pending meanwhile, and shows what the action answered', async () => {
    const posted = page.waitForResponse('/_kay/action/*')

    await page.fill('input[name="title"]', 'abcd')
    await page.click('form button')
    await page.waitFor('form[aria-busy="true"]')
    // Naming its page, as a `Referer` the app's `referrer-policy` cuts would not.
    expect((await posted).requestHeaders['x-kay-page']).toBe(await page.path())
    await page.waitFor('p.done', { text: 'Added abcd' })

    expect(await page.count('form[aria-busy]')).toBe(0)
    expect(await sameDocument()).toBe(true)

    await page.fill('input[name="title"]', 'taken')
    await page.click('form button')
    await page.waitFor('p.error', { text: 'Already taken' })

    expect(await page.value('input[name="title"]')).toBe('taken')
    expect(await sameDocument()).toBe(true)
    expect(await page.text('button.player')).toBe('Played 3')
  })

  it('goes back by swapping too, the page as it was', async () => {
    await page.back()
    await page.waitFor('h1', { text: 'Home' })

    expect(await sameDocument()).toBe(true)
    expect(await page.text('button.player')).toBe('Played 3')
  })

  it('fires kay:navigate on document once each swapped page is in place, with its URL, and not on a full load', async () => {
    // A page of its own, as the tests after this one count on the document and the history the shared page holds.
    const own = await open('/')

    try {
      await own.evaluate(() => {
        const seen: string[] = []

        ;(window as { kayNavigated?: string[] }).kayNavigated = seen
        document.addEventListener('kay:navigate', (event) => {
          seen.push(`${(event as CustomEvent<{ url: string }>).detail.url}|${document.querySelector('h1')?.textContent ?? ''}`)
        })
      })
      expect(await own.evaluate(() => (window as { kayNavigated?: string[] }).kayNavigated)).toEqual([])
      await own.click('a.second')
      await own.waitFor('h1', { text: 'Second' })
      expect(await own.evaluate(() => (window as { kayNavigated?: string[] }).kayNavigated)).toEqual([`${origin}/second|Second`])
      await own.back()
      await own.waitFor('h1', { text: 'Home' })
      expect(await own.evaluate(() => (window as { kayNavigated?: string[] }).kayNavigated)).toEqual([`${origin}/second|Second`, `${origin}/|Home`])
    }
    finally {
      own.close()
    }
  })

  it('swaps in a streamed page with its blocks in place', async () => {
    await page.click('a.later')
    await page.waitFor('p.answer', { text: 'The answer is 42' })

    expect(await page.count('p.pending')).toBe(0)
    expect(await sameDocument()).toBe(true)
    await page.back()
    await page.waitFor('h1', { text: 'Home' })
  })

  it('runs the page\'s loads again after an island calls an action', async () => {
    const before = await page.text('p.bumps')

    await page.click('button.bump')
    await page.waitUntil((text: string | null) => document.querySelector('p.bumps')!.textContent !== text, {}, before)

    expect(await sameDocument()).toBe(true)
  })

  it('keeps on a refresh an island whose children the page renders the same, and renders afresh one whose children changed', async () => {
    await page.evaluate(() => {
      for (const box of document.querySelectorAll('slot[data-component$="box.kay"]'))
        (box as HTMLElement & { kayMark?: string }).kayMark = 'kept'
    })
    await page.click('section.box:has(p.same) button.box-count')
    await page.waitFor('section.box:has(p.same) button.box-count', { text: 'Box 1' })

    const before = await page.text('p.boxed-bumps')

    await page.click('button.bump')
    await page.waitUntil((text: string | null) => document.querySelector('p.boxed-bumps')!.textContent !== text, {}, before)

    expect(await page.evaluate(() => [...document.querySelectorAll('slot[data-component$="box.kay"]')].map(box => (box as HTMLElement & { kayMark?: string }).kayMark ?? 'fresh'))).toEqual(['kept', 'fresh'])
    expect(await page.text('section.box:has(p.same) button.box-count')).toBe('Box 1')
    await page.click('section.box:has(p.boxed-bumps) button.box-count')
    await page.waitFor('section.box:has(p.boxed-bumps) button.box-count', { text: 'Box 1' })
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
      await page.waitFor('h1', { text: heading })
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
    await page.back()
    await page.waitFor('h1', { text: 'Home' })
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
      await page.waitFor('h1', { text: heading })
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
    await page.waitFor('h1', { text: 'Second' })

    const measured = await page.evaluate(() => ({
      html: (window as { counts?: { html: number } }).counts!.html,
      elements: document.head.children.length + document.scripts.length,
    }))

    expect(measured.html).toBeLessThanOrEqual(measured.elements * 3)
  })

  it('keeps the element a script changed in the head between two swaps, and each row of a long list a leading insert moves down', async () => {
    await page.goto('/rows')
    await page.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
      document.querySelector('meta[name="theme-color"]')!.setAttribute('content', '#abcdef')
      for (const [index, row] of document.querySelectorAll('li.row').entries())
        (row as HTMLElement & { index?: number }).index = index
    })
    await page.click('a.lead')
    await page.waitFor('li.new')

    const kept = await page.evaluate(() => ({
      rows: [...document.querySelectorAll('li.row:not(.new)')].filter((row, index) => (row as HTMLElement & { index?: number }).index === index).length,
      first: document.querySelector('ol')!.firstElementChild!.className,
      theme: document.querySelector('meta[name="theme-color"]')!.getAttribute('content'),
    }))

    expect(kept).toEqual({ rows: 1500, first: 'row new', theme: '#abcdef' })
    expect(await sameDocument()).toBe(true)

    await page.evaluate(() => document.querySelector('meta[name="theme-color"]')!.setAttribute('content', '#fedcba'))
    await page.click('a.rows')
    await page.waitUntil(() => document.querySelector('li.new') === null)
    expect(await page.evaluate(() => document.querySelector('meta[name="theme-color"]')!.getAttribute('content'))).toBe('#fedcba')
    expect(await sameDocument()).toBe(true)
  })

  it('matches the opaque selector for the slots, scripts and templates of a long list only, and reads a head element once between mutations', async () => {
    await page.goto('/rows')
    await page.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
      const counts = { matches: 0, html: 0 }
      // eslint-disable-next-line ts/unbound-method -- called back on the element it is read from
      const matches = Element.prototype.matches
      const original = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML')!

      Element.prototype.matches = function (this: Element, selector: string) {
        counts.matches++

        return matches.call(this, selector)
      } as Element['matches']
      Object.defineProperty(Element.prototype, 'outerHTML', { ...original, get(this: Element) {
        counts.html++

        return original.get!.call(this) as string
      } })
      ;(window as { counts?: typeof counts }).counts = counts
    })

    const swap = async (link: string, led: boolean) => {
      await page.evaluate(() => {
        const counts = (window as { counts?: { matches: number, html: number } }).counts!

        counts.matches = 0
        counts.html = 0
      })
      await page.click(`a.${link}`)
      await page.waitUntil((wanted: boolean) => (document.querySelector('li.new') !== null) === wanted, {}, led)

      return page.evaluate(() => ({ ...(window as { counts?: { matches: number, html: number } }).counts! }))
    }

    const first = await swap('lead', true)
    const second = await swap('rows', false)

    expect(first.matches).toBeLessThan(500)
    expect(second.matches).toBeLessThan(500)
    expect(second.html).toBeLessThan(first.html)
    expect(await sameDocument()).toBe(true)
  })

  it('restores where the page was scrolled to when going back, focusing its heading without scrolling and announcing its title', async () => {
    await page.goto(origin)
    await page.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
      scrollTo(0, 1500)
      document.querySelector<HTMLElement>('a.second')!.click()
    })
    await page.waitFor('h1', { text: 'Second' })

    expect(await page.evaluate(() => scrollY)).toBe(0)

    await page.evaluate(() => scrollTo(0, 700))
    await page.waitUntil(() => (history.state as { scroll?: number[] } | null)?.scroll?.[1] === 700)
    await page.back()
    await page.waitFor('h1', { text: 'Home' })

    expect(await page.evaluate(() => scrollY)).toBe(1500)
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('H1')
    await page.waitUntil(() => [...document.querySelectorAll('body > [aria-live="polite"]')].at(-1)?.textContent === document.title)

    await page.forward()
    await page.waitFor('h1', { text: 'Second' })

    expect(await page.evaluate(() => scrollY)).toBe(700)
    expect(await sameDocument()).toBe(true)

    await page.reload()
    await page.waitFor('h1', { text: 'Second' })
    await page.waitUntil(() => scrollY === 700)
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
    await page.waitFor('h1', { text: 'Second' })

    expect(await sameDocument()).toBe(true)
    expect(await page.evaluate(() => (document.querySelector('#side') as HTMLElement & { kayMark?: string }).kayMark)).toBe('kept')
    expect(await page.evaluate(() => document.querySelector('#side')!.scrollTop)).toBe(200)
    expect(await page.evaluate(() => document.querySelector('a.second')!.getAttribute('aria-current'))).toBe('page')
    expect(await page.evaluate(() => document.querySelector('a.home')!.getAttribute('aria-current'))).toBeNull()
    // A drawer left open closes as the page changes.
    expect(await page.evaluate(() => document.querySelector('#drawer')!.matches(':popover-open'))).toBe(false)
  })

  it('swaps on a browser without popovers, which throws on the :popover-open selector', async () => {
    const fresh = await open('/')

    try {
      await fresh.initScript(() => {
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
      await fresh.waitFor('h1', { text: 'Second' })

      expect(await sameDocument(fresh)).toBe(true)
      expect(fresh.errors).toEqual([])
    }
    finally {
      fresh.close()
    }
  })

  it('keeps the scroll and skips the view transition when asked, by navigate() or a link, and goes to the top otherwise', async () => {
    const fresh = await open('/')
    const go = async (click: string) => {
      await fresh.goto('/scrolled')
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
      await addStyle(fresh, '@view-transition { navigation: auto; }')
      await fresh.evaluate(() => scrollTo(0, 1200))
      // Clicked from the page's script, as a real click would scroll the control into view first.
      await fresh.evaluate(selector => document.querySelector<HTMLElement>(selector)!.click(), click)
      await fresh.waitFor('h1', { text: 'Second' })

      return fresh.evaluate(() => ({ scroll: scrollY > 1000 ? 'kept' : scrollY, transitions: (window as { kayTransitions?: number }).kayTransitions, swapped: (window as { kayAlive?: boolean }).kayAlive === true }))
    }

    try {
      expect(await go('button.plain')).toEqual({ scroll: 0, transitions: 1, swapped: true })
      expect(await go('button.keep')).toEqual({ scroll: 'kept', transitions: 1, swapped: true })

      // A query change keeps the scroll by itself, and goes to the top when asked.
      await fresh.goto('/scrolled')
      await fresh.evaluate(() => scrollTo(0, 1200))
      await fresh.evaluate(() => document.querySelector<HTMLElement>('button.top')!.click())
      await fresh.waitUntil(() => location.search === '?sort=z')
      await fresh.waitUntil(() => scrollY === 0)

      expect(await go('button.still')).toEqual({ scroll: 'kept', transitions: 0, swapped: true })
      expect(await go('a.plain-link')).toEqual({ scroll: 0, transitions: 1, swapped: true })
      expect(await go('a.keep-link')).toEqual({ scroll: 'kept', transitions: 1, swapped: true })
      expect(await go('a.group-link')).toEqual({ scroll: 'kept', transitions: 0, swapped: true })

      // Back to the page left restores where it was, whatever kept the scroll going there.
      await fresh.back()
      await fresh.waitFor('h1', { text: 'Scrolled' })
      await fresh.waitUntil(() => scrollY > 1000)
    }
    finally {
      fresh.close()
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
    await page.waitUntil(() => scrollY > 0)
    await page.click('button.player')
    await page.back()
    await page.waitUntil(() => scrollY === 0)

    expect(await sameDocument()).toBe(true)
    expect(await page.text('button.player')).toBe('Played 1')
  })

  it('asks before leaving a page with unsaved changes, once for every guard, and stays as it was when refused', async () => {
    const asked: string[] = []
    let answer = false
    // A refused leave changes nothing, so it is waited for as the question, then until the page has run what it had queued.
    const refused = async (count: number) => {
      await until(() => asked.length === count)
      await settled(page)
      expect(await page.text('h1')).toBe('Guarded')
      expect(await sameDocument()).toBe(true)
    }

    await page.onDialog((dialog) => {
      asked.push(`${dialog.type} ${dialog.message}`)

      return answer
    })

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
      await page.waitFor('h1', { text: 'Guarded' })
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
      await page.waitUntil(() => location.pathname === '/guarded')
      expect(await page.value('.one input.draft')).toBe('draft')
      expect(await page.evaluate(() => scrollY)).toBe(400)

      // Neither an island's own URL state nor a post to an action of the page is a leave.
      await page.click('.two button.tab')
      expect(await page.path()).toBe('/guarded?tab=b')
      await page.click('a.second')
      await refused(5)
      expect(await page.path()).toBe('/guarded?tab=b')

      await page.click('button.save')
      await page.waitUntil(() => document.querySelector<HTMLInputElement>('.one input.draft')!.value === '')
      expect(asked).toHaveLength(5)

      await page.fill('.two input.draft', 'draft')
      await page.evaluate(() => location.reload())
      await refused(6)
      expect(asked[5]).toStartWith('beforeunload')

      answer = true
      await page.evaluate(() => history.back())
      await page.waitFor('h1', { text: 'Home' })
      expect(asked).toHaveLength(7)
      expect(await sameDocument()).toBe(true)

      // The guards went with their page: nothing asks any more.
      await page.reload()
      await page.waitFor('h1', { text: 'Home' })
      expect(asked).toHaveLength(7)
    }
    finally {
      await page.onDialog(() => false)
    }
  })

  it('still works without JavaScript, as full page loads', async () => {
    const plain = await open('/second', { javaScript: false })

    try {
      await plain.fill('input[name="title"]', 'taken')
      await plain.click('form button')
      await plain.waitFor('p.error', { text: 'Already taken' })
      await plain.click('a.home')
      await plain.waitFor('h1', { text: 'Home' })
    }
    finally {
      plain.close()
    }
  })

  it('never fetches a rel=nofollow link ahead, and swaps it in once clicked', async () => {
    const fresh = await open('/')
    const fetched = () => fresh.responses.filter(({ url }) => new URL(url).pathname === '/state').map(({ url }) => url)

    try {
      await fresh.evaluate(() => {
        (window as { kayAlive?: boolean }).kayAlive = true
      })
      await fresh.hover('a.nofollow')
      // Past the hover delay a followed link would be fetched after, waited out on the real clock.
      await Bun.sleep(600)
      await settled(fresh)
      expect(fetched()).toEqual([])
      await fresh.click('a.nofollow')
      await fresh.waitUntil(() => location.pathname === '/state')

      expect(fetched()).toHaveLength(1)
      expect(await sameDocument(fresh)).toBe(true)
    }
    finally {
      fresh.close()
    }
  })

  it('loads a page from a link opting out', async () => {
    await page.click('a.reload')
    await page.waitFor('h1', { text: 'Plain' })

    expect(await sameDocument()).toBe(false)
  })

  it('loads fully a page asking for it, and one whose cross-origin isolation differs from this one\'s', async () => {
    const mark = async () => page.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
    })
    const follow = async (link: string, title: string) => {
      await mark()
      await page.click(link)
      await page.waitFor('h1', { text: title })
    }

    await page.goto(origin)
    await follow('a.whole', 'Whole')
    expect(await sameDocument()).toBe(false)
    // The page itself, its query changed, is still swapped in place.
    await mark()
    await page.click('button.sort')
    await page.waitFor('p.whole-sorted', { text: 'Sorted name' })
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
    await page.goto('/state')
    await page.waitFor('p.total', { text: 'Total 5' })
    await page.click('button.adder')
    await page.waitFor('p.total', { text: 'Total 6' })
  })

  it('renders a try block\'s catch block once it throws, keeping the one the server rendered, and reports the error', async () => {
    const reports: string[] = []
    const fromHere = page.warnings.length

    await page.route('/_kay/error', (request) => {
      reports.push(request.body ?? '')
    })

    try {
      await page.goto('/fallback')
      await page.waitFor('p.fragile', { text: 'Fine' })

      expect(await page.text('p.unavailable')).toBe('Unavailable')

      await page.click('button.break')
      await page.waitFor('p.fallback', { text: 'Failed: Fragile broke' })

      expect(await page.count('p.fragile')).toBe(0)
      await until(() => reports.length > 0)
      expect(reports.map(body => JSON.parse(body) as Record<string, unknown>)).toEqual([{ name: 'Error', message: 'Fragile broke', stack: expect.any(String), island: 'tests/fixtures/navigation/src/components/fragile.kay', url: `${origin}/fallback` }])
      expect(page.warnings.slice(fromHere)).toEqual([])
    }
    finally {
      await page.unroute('/_kay/error')
    }
  })

  it('hands what a component provides to what it renders in the browser too, a block rendered later included', async () => {
    const problem = problems(page)

    await page.goto('/tone')
    await page.click('button.open')
    await page.waitFor('button.open', { text: 'Open' })

    expect(await page.evaluate(() => [...document.querySelectorAll('section.box p.tone')].map(tone => tone.textContent))).toEqual(['loud', 'loud'])
    expect(await page.text('body > p.tone')).toBe('layout')
    expect(await page.text('button.reader')).toBe('plain')
    expect(problem()).toEqual([])
  })

  it('keeps a persisted signal in a cookie the server renders with, and one in localStorage applied once hydrated', async () => {
    const problem = problems(page)

    await page.goto('/state')
    await page.click('button.theme')
    await page.click('button.note')
    await page.waitFor('button.note', { text: 'Note kept' })

    expect(await fetchText(page, '/alone')).toContain('Theme <!--[-->dark<!--]-->')

    await page.goto('/alone')
    await page.waitFor('button.note', { text: 'Note kept' })

    expect(await page.text('button.theme')).toBe('Theme dark')
    expect(problem()).toEqual([])
  })

  it('keeps a persisted signal in the query the server renders with, its default leaving the URL plain, and merges a query into the page in place', async () => {
    const problem = problems(page)

    expect(await fetchText(page, '/query?q=kept')).toContain('Searched <!--[-->kept<!--]-->')

    await page.goto('/query?q=kept')
    await page.fill('input.search', 'typed')
    await page.waitUntil(() => location.search === '?q=typed')
    await page.fill('input.search', '')
    await page.waitUntil(() => location.search === '')
    await page.fill('input.search', 'again')

    // Pressed from the keyboard, as a click scrolls the button to the middle of the view first.
    const scrolled = await page.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
      document.querySelector<HTMLElement>('button.sort')!.focus({ preventScroll: true })
      window.scrollTo(0, 1000)

      return scrollY
    })

    await page.press('Enter')
    await page.waitFor('p.sorted', { text: 'Sorted name' })

    expect(await sameDocument()).toBe(true)
    expect(await page.evaluate(() => [location.search, scrollY, document.activeElement?.className])).toEqual(['?q=again&sort=name', scrolled, 'sort'])
    expect(await page.text('p.searched')).toBe('Searched again')

    // Back to an entry of the same path keeps the focus where it was, as following the query did.
    await page.back()
    await page.waitFor('p.sorted', { text: 'Sorted none' })

    expect(await page.evaluate(() => document.activeElement?.className)).toBe('sort')
    expect(problem()).toEqual([])
  })

  it('keeps a query param typed by the page\'s schema, the server rendering it and its default leaving the URL plain', async () => {
    const problem = problems(page)
    const html = await fetchText(page, '/paged?page=3&tags=a')

    expect(html).toContain('<script type="application/json" data-kay-query>')
    expect(html).toContain('Page <!--[-->3<!--]--> <!--[-->number<!--]--> <!--[-->a<!--]--> <!--[-->grid<!--]-->')

    await page.goto('/paged?page=3&tags=a')
    await page.click('button.next')
    await page.waitFor('p.paged', { text: 'Page 4 number a grid' })
    await page.click('button.tag')
    await page.click('button.list')
    await page.waitUntil(() => location.search === '?page=4&tags=a&tags=b&view=list')
    await page.click('button.first')
    await page.waitUntil(() => location.search === '?tags=a&tags=b&view=list')
    expect(problem()).toEqual([])
  })

  it('focuses the field a post was refused for, described by its message', async () => {
    await page.goto('/second')
    await page.fill('input[name="title"]', 'ab')
    await page.evaluate(() => document.querySelector<HTMLElement>('button.unchecked')!.focus())
    await page.press('Enter')
    await page.waitFor('p.title-error', { text: 'Too short' })
    await page.waitUntil(() => document.activeElement?.getAttribute('name') === 'title')

    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-describedby'))).toBe('add-title-error')
    expect(await page.evaluate(() => document.getElementById('add-title-error')?.textContent)).toBe('Too short')
  })

  it('reveals the field a post was refused for when it is hidden until found, as find-in-page does', async () => {
    await page.goto('/hidden')
    await page.evaluate(() => {
      const matched: string[] = []

      ;(window as { matched?: string[] }).matched = matched
      document.addEventListener('beforematch', event => matched.push((event.target as Element).className))
      document.querySelector<HTMLInputElement>('input[name="code"]')!.value = 'ab'
    })
    await page.click('button.unchecked')
    await page.waitUntil(() => document.activeElement?.getAttribute('name') === 'code')

    expect(await page.evaluate(() => (window as { matched?: string[] }).matched)).toEqual(['panel'])
    expect(await page.evaluate(() => document.querySelector('section.panel')!.hasAttribute('hidden'))).toBe(false)
    expect(await page.text('p.code-error')).toBe('Too short')
  })

  it('announces a form\'s own refusal, the button that posted it focused again', async () => {
    await page.goto('/second')
    await page.fill('input[name="title"]', 'busy')
    await page.evaluate(() => document.querySelector<HTMLElement>('form button')!.focus())
    await page.press('Enter')
    await page.waitFor('p.form-error', { text: 'Try later' })
    await page.waitUntil(() => [...document.querySelectorAll('body > [aria-live="polite"]')].some(region => region.textContent === 'Try later'))

    expect(await page.evaluate(() => document.querySelector('form')?.getAttribute('aria-describedby'))).toBe('add-error')
    expect(await page.evaluate(() => document.activeElement === document.querySelector('form button'))).toBe(true)
  })

  it('animates a swap where a stylesheet opts in under a condition that holds, and never for a visitor asking for less motion', async () => {
    const transitions = async (reducedMotion: 'reduce' | 'no-preference', css: string): Promise<number> => {
      const fresh = await open('/', { reducedMotion })

      try {
        await addStyle(fresh, css)
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
        await fresh.waitFor('h1', { text: 'Second' })

        return await fresh.evaluate(() => (window as { kayTransitions?: number }).kayTransitions!)
      }
      finally {
        fresh.close()
      }
    }

    expect(await transitions('no-preference', '@media (prefers-reduced-motion: no-preference) { @view-transition { navigation: auto; } }')).toBe(1)
    expect(await transitions('no-preference', '@supports (display: grid) { @view-transition { navigation: auto; } }')).toBe(1)
    expect(await transitions('reduce', '@media (prefers-reduced-motion: no-preference) { @view-transition { navigation: auto; } }')).toBe(0)
    expect(await transitions('reduce', '@view-transition { navigation: auto; }')).toBe(0)
  })

  it('brings the next page\'s inlined stylesheet with the swap and drops it again going back', async () => {
    const fresh = await open('/')
    const rules = async () => fresh.evaluate(() => [...document.head.querySelectorAll('style')].filter(style => style.textContent.includes('.bar')).length)

    try {
      await fresh.evaluate(() => {
        (window as { kayAlive?: boolean }).kayAlive = true
        document.body.insertAdjacentHTML('beforeend', '<a class="to-below" href="/below">Below</a>')
      })
      expect(await rules()).toBe(0)
      await fresh.click('a.to-below')
      await fresh.waitFor('h1', { text: 'Below' })

      expect(await rules()).toBe(1)
      expect(await fresh.evaluate(() => getComputedStyle(document.querySelector('.bar')!).position)).toBe('fixed')
      expect(await sameDocument(fresh)).toBe(true)
      await fresh.back()
      await fresh.waitFor('h1', { text: 'Home' })

      expect(await rules()).toBe(0)
    }
    finally {
      fresh.close()
    }
  })

  it('swaps from a page linking its stylesheet to one inlining its own, and back', async () => {
    const fresh = await open('/heavy')
    const state = async () => fresh.evaluate(() => ({
      linked: document.head.querySelectorAll('link[rel="stylesheet"]').length,
      inlined: [...document.head.querySelectorAll('style')].filter(style => style.textContent.includes('.bar')).length,
    }))

    try {
      await fresh.evaluate(() => {
        (window as { kayAlive?: boolean }).kayAlive = true
      })

      const before = await state()

      expect(before.linked).toBeGreaterThan(0)
      expect(before.inlined).toBe(0)
      await fresh.click('a.to-below')
      await fresh.waitFor('h1', { text: 'Below' })
      expect((await state()).inlined).toBe(1)
      expect(await fresh.evaluate(() => getComputedStyle(document.querySelector('.bar')!).position)).toBe('fixed')
      await fresh.back()
      await fresh.waitFor('h1', { text: 'Heavy' })

      expect(await state()).toEqual(before)
      expect(await sameDocument(fresh)).toBe(true)
    }
    finally {
      fresh.close()
    }
  })

  it('swaps in the page a post redirects to, another one taking a history entry', async () => {
    const fresh = await open('/posted')

    try {
      await fresh.evaluate(() => {
        (window as { kayAlive?: boolean }).kayAlive = true
      })
      await fresh.click('form.away button')
      await fresh.waitFor('h1', { text: 'Plain' })

      expect([await fresh.path(), await sameDocument(fresh)]).toEqual(['/plain', true])

      await fresh.back()
      await fresh.waitFor('h1', { text: 'Posted' })
      expect(await sameDocument(fresh)).toBe(true)
    }
    finally {
      fresh.close()
    }
  })

  it('shows in place the error page a post is answered with, the address and the history kept', async () => {
    const fresh = await open('/posted')

    try {
      await fresh.evaluate(() => {
        (window as { kayAlive?: boolean }).kayAlive = true
      })

      const entries = await fresh.evaluate(() => history.length)
      const answered = fresh.waitForResponse('/_kay/action/*')

      await fresh.click('form.crash button')
      expect((await answered).status).toBe(500)
      await fresh.waitUntil(() => document.querySelector('form.crash') === null)

      expect(await fresh.evaluate(() => [location.pathname, history.length, (window as { kayAlive?: boolean }).kayAlive])).toEqual(['/posted', entries, true])
    }
    finally {
      fresh.close()
    }
  })

  it('shows how much of a form\'s upload went, on the form and its progress bars, then nothing once sent', async () => {
    const fresh = await open('/posted')

    try {
      await fresh.upload('form.upload input', await bigFile())
      await fresh.evaluate(() => {
        const form = document.querySelector<HTMLFormElement>('form.upload')!
        const seen: [string, number][] = []

        ;(window as { seen?: typeof seen }).seen = seen
        new MutationObserver(() => seen.push([form.style.getPropertyValue('--kay-progress'), form.querySelector('progress')!.value])).observe(form, { attributes: true, attributeFilter: ['style'] })
      })
      await fresh.click('form.upload button')
      await fresh.waitFor('p.sent', { text: `Sent ${4 * 1024 * 1024}` })

      const seen = await fresh.evaluate(() => (window as { seen?: [string, number][] }).seen!)
      const sent = seen.filter(([progress]) => progress !== '')

      expect(sent.length).toBeGreaterThan(0)
      expect(sent.at(-1)).toEqual(['1', 1])
      expect(sent.every(([progress, value]) => Number(progress) === value && value > 0 && value <= 1)).toBe(true)
      expect(seen.at(-1)![0]).toBe('')
    }
    finally {
      fresh.close()
    }
  })

  it('never posts a form again natively once the server had it, only the answer lost: the page loads and the action ran once', async () => {
    const proxy = lossyProxy(Number(new URL(origin).port))
    const fresh = await browse(`http://127.0.0.1:${proxy.port}/posted#top`, VIEWPORT)

    try {
      await fresh.evaluate(() => {
        (window as { kayAlive?: boolean }).kayAlive = true
      })
      await fresh.click('form.count button')
      await fresh.waitUntil(() => (window as { kayAlive?: boolean }).kayAlive === undefined)
      await fresh.waitFor('p.posts')
      await settled(fresh)

      expect(await fresh.text('p.posts')).toBe('1')
    }
    finally {
      proxy.stop()
      fresh.close()
    }
  })

  for (const how of ['refused', 'reset-request'] as const) {
    it(`posts a form natively when the swap's post never reached the server: ${how === 'refused' ? 'a refused connection' : 'an upload cut before its body went out'}`, async () => {
      const proxy = lossyProxy(Number(new URL(origin).port), 'reset-request')
      const fresh = await browse(`http://127.0.0.1:${proxy.port}/posted`, VIEWPORT)
      const documents: string[] = []

      try {
        await fresh.route(() => true, (request) => {
          if (request.type === 'document')
            documents.push(request.method)
        })
        await fresh.goto('/posted')
        await fresh.evaluate(() => {
          (window as { kayAlive?: boolean }).kayAlive = true
        })

        if (how === 'refused')
          proxy.stop()
        else
          await fresh.upload('form.upload input', await bigFile())

        await fresh.click(how === 'refused' ? 'form.count button' : 'form.upload button')
        await fresh.waitUntil(() => (window as { kayAlive?: boolean }).kayAlive === undefined)
        await settled(fresh)

        expect(documents).toEqual(['GET', 'POST'])
      }
      finally {
        proxy.stop()
        fresh.close()
      }
    })
  }

  it('leaves a form to the browser when form posting cannot load', async () => {
    const fresh = await open('/')

    try {
      await fresh.route(/\/forms-[^/]*\.js$/, async request => request.abort())
      await fresh.goto('/posted')
      await fresh.evaluate(() => {
        (window as { kayAlive?: boolean }).kayAlive = true
      })
      await fresh.click('form.away button')
      await fresh.waitFor('h1', { text: 'Plain' })

      expect(await fresh.evaluate(() => (window as { kayAlive?: boolean }).kayAlive)).toBeUndefined()
    }
    finally {
      fresh.close()
    }
  })

  it('shows the page of the last navigation started, one started earlier and answered later dropped', async () => {
    const fresh = await open('/plain')

    try {
      const entries = await fresh.evaluate(() => history.length)

      // The earlier navigation's answer is held until the later one has shown its page.
      const { promise: held, resolve: release } = Promise.withResolvers<void>()

      await fresh.route(`${origin}/second`, async (request) => {
        await held
        await request.continue()
      })
      await fresh.click('a.second')
      await fresh.click('a.home')
      await fresh.waitFor('h1', { text: 'Home' })

      const answered = fresh.waitForResponse(`${origin}/second`)

      release()
      await answered
      await settled(fresh)

      expect(await fresh.evaluate(() => [location.pathname, document.querySelector('h1')!.textContent, history.length])).toEqual(['/', 'Home', entries + 1])
    }
    finally {
      fresh.close()
    }
  })

  it('focuses the main of a page without a heading', async () => {
    await page.goto(origin)
    await page.evaluate(() => {
      const link = Object.assign(document.createElement('a'), { href: '/contrast', className: 'contrast' })

      document.body.append(link)
      link.click()
    })
    await page.waitFor('button.faint')

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
    await page.waitFor('h1', { text: 'Focused' })

    expect(await page.evaluate(() => document.activeElement?.className)).toBe('name')

    await follow('/contrast')
    await page.waitFor('button.faint')
    await page.back()
    await page.waitFor('h1', { text: 'Focused' })

    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('H1')
  })

  it('announces the swapped page without making it any taller, so one filling the screen gets no scrollbar', async () => {
    await page.goto(origin)
    await page.click('a.second')
    await page.waitUntil(() => document.querySelector('body > [aria-live="polite"]')?.textContent)

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
    // A server of its own on a fresh origin, killed once the worker holds the pages: the page's own offline switch does not reach the worker's fetches.
    const worker = await startFixture()
    const own = await browse(worker.origin, VIEWPORT)

    try {
      await own.waitUntil(async () => (await navigator.serviceWorker.ready).active?.state === 'activated' && navigator.serviceWorker.controller !== null, { timeout: 10_000 })
      await own.goto('/second')
      worker.server.kill()
      await worker.server.exited

      await own.goto('/')
      expect(await own.text('h1')).toBe('Home')

      // The page swap fetches the next page through the worker too.
      await own.evaluate(() => {
        (window as { kayAlive?: boolean }).kayAlive = true
      })
      await own.click('a.second')
      await own.waitFor('h1', { text: 'Second' })
      expect(await sameDocument(own)).toBe(true)

      // Islands hydrate from the chunks it keeps.
      await own.click('button.player')
      await own.waitFor('button.player', { text: 'Played 1' })

      await own.goto('/plain')

      expect(await own.evaluate(() => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).responseStatus)).toBe(503)
      expect(await own.text('h1')).toBe('Offline')
      expect(await own.evaluate(async () => {
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
      own.close()
      worker.server.kill()
      await worker.server.exited
    }
  }, 30_000)
})
