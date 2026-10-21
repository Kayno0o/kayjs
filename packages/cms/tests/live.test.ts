import type { SavedState } from '../src/editor/live'
import { describe, expect, test } from 'bun:test'
import { savedHandler, whenLive } from '../src/editor/live'

// A page answering the texts in turn, the last one for good.
function pageSaying(...texts: string[]) {
  const reads: string[] = []

  return { reads, read: async (url: string) => {
    reads.push(url)

    return texts[Math.min(reads.length - 1, texts.length - 1)]!
  } }
}

const quick = { pause: async () => undefined, interval: 1000 }

describe('whenLive', () => {
  test('is live once the page changed and held still for two reads', async () => {
    const page = pageSaying('old', 'old', 'new', 'new')

    expect(await whenLive('/talk', { ...quick, read: page.read })).toBe(true)
    expect(page.reads).toEqual(['/talk', '/talk', '/talk', '/talk'])
  })

  test('is not live while the site is down or erroring, however many reads say so', async () => {
    const page = pageSaying('200\nold', undefined as unknown as string, undefined as unknown as string, undefined as unknown as string)

    expect(await whenLive('/talk', { ...quick, window: 4000, read: page.read })).toBe(false)
  })

  test('reads the page under the site base', async () => {
    const urls: string[] = []
    const fetched = globalThis.fetch

    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(String(input))

      return new Response('ok')
    }) as typeof fetch

    try {
      const { readPage } = await import('../src/editor/live')

      expect(await readPage('/talk')).toBe('200\nok')
      expect(urls).toEqual(['/talk'])
    }
    finally {
      globalThis.fetch = fetched
    }
  })

  test('is not live for a page that changes on every read', async () => {
    let n = 0

    expect(await whenLive('/talk', { ...quick, window: 10_000, read: async () => `read ${n++}` })).toBe(false)
  })

  test('is not live for a page that never changes, once the window passes', async () => {
    const page = pageSaying('same')

    expect(await whenLive('/talk', { ...quick, window: 5000, read: page.read })).toBe(false)
    expect(page.reads).toHaveLength(6)
  })

  test('stops reading once cancelled', async () => {
    const page = pageSaying('old', 'new')

    expect(await whenLive('/talk', { ...quick, read: page.read, cancelled: () => true })).toBe(false)
    expect(page.reads).toHaveLength(1)
  })
})

describe('savedHandler', () => {
  const settle = async () => Bun.sleep(5)

  test('records a save that waits for a rebuild, then turns it live when the page serves it', async () => {
    const states: unknown[] = []
    let finished = 0
    const page = pageSaying('old', 'new', 'new')
    const saved = savedHandler(() => '/talk', state => states.push(state), () => finished++, { ...quick, read: page.read })

    saved({ rebuilding: true })
    await settle()
    expect(states).toEqual([expect.objectContaining({ rebuilding: true }), expect.objectContaining({ rebuilding: false, live: true })])
    expect(finished).toBe(1)
  })

  test('reads no page for a save with no rebuild or an entry with no page', async () => {
    const page = pageSaying('old')
    const states: unknown[] = []

    savedHandler(() => '/talk', state => states.push(state), () => undefined, { ...quick, read: page.read })({ rebuilding: false })
    savedHandler(() => undefined, state => states.push(state), () => undefined, { ...quick, read: page.read })({ rebuilding: true })
    await settle()
    expect(page.reads).toEqual([])
    expect(states).toHaveLength(2)
  })

  test('lets a newer save take over from an older watch', async () => {
    const states: SavedState[] = []
    let finished = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const page = pageSaying('old', 'new', 'new')
    const saved = savedHandler(() => '/talk', state => states.push(state), () => finished++, { read: page.read, pause: async () => gate, interval: 1000 })

    saved({ rebuilding: true })
    saved({ rebuilding: false })
    release()
    await settle()
    expect(states.some(state => state.live)).toBe(false)
    expect(finished).toBe(0)
  })
})
