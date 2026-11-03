import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it, setSystemTime, spyOn } from 'bun:test'

describe('pages fetched ahead of a click', () => {
  beforeAll(() => {
    GlobalRegistrator.register({ url: 'http://localhost/' })
  })

  afterAll(async () => {
    setSystemTime()
    await GlobalRegistrator.unregister()
  })

  it('are dropped once their time has passed, when another is fetched', async () => {
    const { prefetch } = await import('../src/runtime/page-swap')
    const { prefetched } = await import('../src/runtime/navigation')
    const fetched = spyOn(globalThis, 'fetch').mockImplementation((async () => new Response('<p>x</p>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch)
    const link = document.createElement('a')

    try {
      prefetch(new URL('http://localhost/one'), link)
      prefetch(new URL('http://localhost/two'), link)
      expect([...prefetched.keys()]).toEqual(['http://localhost/one', 'http://localhost/two'])

      setSystemTime(new Date(Date.now() + 60_000))
      prefetch(new URL('http://localhost/three'), link)

      expect([...prefetched.keys()]).toEqual(['http://localhost/three'])
    }
    finally {
      fetched.mockRestore()
      prefetched.clear()
      setSystemTime()
    }
  })

  describe('by level', () => {
    let runs = 100

    const start = async (level: string) => {
      const { startPrefetch } = await import(`../src/runtime/prefetch.ts?run=${++runs}`) as typeof import('../src/runtime/prefetch')

      startPrefetch(level)
    }

    const link = (href: string, within = '') => {
      document.body.insertAdjacentHTML('beforeend', `<div ${within}><a href="${href}">x</a></div>`)

      return document.body.lastElementChild!.firstElementChild as HTMLAnchorElement
    }

    const fire = (target: Element, type: string) => target.dispatchEvent(new Event(type, { bubbles: true }))
    const settle = async () => new Promise(done => setTimeout(done, 20))

    it('sends a link its own level, and none to `data-prefetch="false"`', async () => {
      const { prefetched } = await import('../src/runtime/navigation')
      const fetched = spyOn(globalThis, 'fetch').mockImplementation((async () => new Response('<p>x</p>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch)

      try {
        await start('conservative')

        const plain = link('/plain')
        const eager = link('/hovered', 'data-prefetch="eager"')
        const off = link('/off', 'data-prefetch="false"')

        fire(plain, 'pointerover')
        fire(plain, 'focusin')
        fire(off, 'pointerdown')
        await settle()
        expect(fetched).not.toHaveBeenCalled()

        fire(plain, 'pointerdown')
        fire(eager, 'pointerover')
        await settle()
        expect(fetched.mock.calls.map(call => call[0]).sort()).toEqual(['http://localhost/hovered', 'http://localhost/plain'])
      }
      finally {
        fetched.mockRestore()
        prefetched.clear()
        document.body.replaceChildren()
      }
    })

    it('fetches the links scrolled into view on an eager page, three at a time', async () => {
      const { prefetched } = await import('../src/runtime/navigation')
      const finish: (() => void)[] = []
      const fetched = spyOn(globalThis, 'fetch').mockImplementation((async () => new Promise<Response>((done) => {
        finish.push(() => done(new Response('<p>x</p>', { headers: { 'content-type': 'text/html' } })))
      })) as unknown as typeof fetch)

      let notify: (entries: { isIntersecting: boolean, target: Element }[]) => void = () => undefined
      const observed: Element[] = []

      globalThis.IntersectionObserver = class {
        constructor(callback: typeof notify) {
          notify = callback
        }

        observe(target: Element) {
          observed.push(target)
        }

        unobserve() {
          return undefined
        }
      } as unknown as typeof IntersectionObserver

      try {
        const links = ['/a', '/b', '/c', '/d', '/e'].map(href => link(href))
        const off = link('/off', 'data-prefetch="false"')

        await start('eager')
        expect(observed).toEqual(links)
        expect(observed).not.toContain(off)

        notify(links.map(target => ({ isIntersecting: true, target })))
        await settle()
        expect(fetched).toHaveBeenCalledTimes(3)

        finish.shift()!()
        await settle()
        expect(fetched).toHaveBeenCalledTimes(4)
      }
      finally {
        fetched.mockRestore()
        prefetched.clear()
        document.body.replaceChildren()
      }
    })
  })

  describe('for a visitor asking for less data', () => {
    let runs = 0

    const listening = async (setup: () => (() => void) | undefined) => {
      const restore = setup()
      const added = spyOn(document, 'addEventListener')

      try {
        // A fresh module each time, as the listeners it keeps are the page's, started once.
        const { startPrefetch } = await import(`../src/runtime/prefetch.ts?run=${++runs}`) as typeof import('../src/runtime/prefetch')

        startPrefetch('moderate')

        return added.mock.calls.map(call => call[0])
      }
      finally {
        added.mockRestore()
        restore?.()
      }
    }

    const withConnection = (saveData: boolean) => () => {
      Object.defineProperty(navigator, 'connection', { value: { saveData }, configurable: true })

      return () => Reflect.deleteProperty(navigator, 'connection')
    }

    it('listens to hover and focus for anyone else', async () => {
      expect(await listening(withConnection(false))).toEqual(['kay:navigate', 'pointerover', 'focusin', 'pointerdown'])
    })

    it('listens to nothing when the browser reports Save-Data', async () => {
      expect(await listening(withConnection(true))).toEqual([])
    })

    it('listens to nothing under prefers-reduced-data, where no header is sent', async () => {
      const matches = spyOn(window, 'matchMedia').mockImplementation(((query: string) => ({ matches: query === '(prefers-reduced-data: reduce)' })) as unknown as typeof matchMedia)

      try {
        expect(await listening(() => undefined)).toEqual([])
      }
      finally {
        matches.mockRestore()
      }
    })

    it('listens as usual when the config turned the behavior off, the visitor asking or not', async () => {
      const meta = document.createElement('meta')

      meta.name = 'kay-save-data'
      meta.content = 'off'
      document.head.append(meta)

      try {
        expect(await listening(withConnection(true))).toEqual(['kay:navigate', 'pointerover', 'focusin', 'pointerdown'])
      }
      finally {
        meta.remove()
      }
    })
  })
})
