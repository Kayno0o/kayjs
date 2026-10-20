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

  describe('for a visitor asking for less data', () => {
    let runs = 0
    const RULES = JSON.stringify({ prefetch: [{ source: 'document', eagerness: 'moderate' }] })

    const listening = async (setup: () => (() => void) | undefined) => {
      const restore = setup()
      const added = spyOn(document, 'addEventListener')

      try {
        // A fresh module each time, as the listeners it keeps are the page's, started once.
        const { startPrefetch } = await import(`../src/runtime/prefetch.ts?run=${++runs}`) as typeof import('../src/runtime/prefetch')

        startPrefetch(RULES)

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
      expect(await listening(withConnection(false))).toEqual(['pointerover', 'focusin'])
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
        expect(await listening(withConnection(true))).toEqual(['pointerover', 'focusin'])
      }
      finally {
        meta.remove()
      }
    })
  })
})
