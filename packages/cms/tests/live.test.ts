import type { SavedState } from '../src/editor/live'
import { describe, expect, test } from 'bun:test'
import { savedHandler, whenLive } from '../src/editor/live'
import { until } from './until'

// A page answering the texts in turn, the last one for good.
function pageSaying(...texts: string[]) {
  const reads: string[] = []

  return { reads, read: async (url: string) => {
    reads.push(url)

    return texts[Math.min(reads.length - 1, texts.length - 1)]!
  } }
}

// The watch under test runs on microtasks alone, so a turn of the event loop lets everything it will ever do happen.
const settle = async () => new Promise(resolve => setTimeout(resolve, 0))

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
  test('records a save that waits for a rebuild, then turns it live when the page serves it', async () => {
    const states: unknown[] = []
    let finished = 0
    const page = pageSaying('old', 'new', 'new')
    const saved = savedHandler(() => '/talk', state => states.push(state), () => finished++, { ...quick, read: page.read })

    saved({ rebuilding: true })
    await until(() => finished === 1)
    expect(states).toEqual([expect.objectContaining({ rebuilding: true }), expect.objectContaining({ rebuilding: false, live: true })])
    expect(finished).toBe(1)
  })

  test('reads no page for a save with no rebuild or an entry with no page', async () => {
    const page = pageSaying('old')
    const states: unknown[] = []

    savedHandler(() => '/talk', state => states.push(state), () => undefined, { ...quick, read: page.read })({ rebuilding: false })
    savedHandler(() => undefined, state => states.push(state), () => undefined, { ...quick, read: page.read })({ rebuilding: true })
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

describe('savedHandler stop', () => {
  test('ends the watch with the form: nothing is set or finished after it', async () => {
    const states: SavedState[] = []
    let finished = 0
    const page = pageSaying('old', 'new', 'new', 'new')
    const handler = savedHandler(() => '/talk', state => states.push(state), () => finished++, { ...quick, read: page.read })

    handler({ rebuilding: true })
    handler.stop()
    await settle()

    expect(finished).toBe(0)
    expect(states).toHaveLength(1)
    expect(page.reads.length).toBeLessThanOrEqual(1)
  })
})

// The server's stream as a test drives it: the ids it pushes, and the moment it refuses.
function pushing() {
  const heard: ((event: { value: string }) => void)[] = []
  const refused: (() => void)[] = []
  let started = 0

  return {
    get started() {
      return started
    },
    instances: {
      start: () => started++,
      onData: (listener: (event: { value: string }) => void) => {
        heard.push(listener)

        return () => void heard.splice(heard.indexOf(listener), 1)
      },
      onError: (listener: () => void) => {
        refused.push(listener)

        return () => void refused.splice(refused.indexOf(listener), 1)
      },
    },
    hear: (value: string) => {
      for (const listener of heard.slice())
        listener({ value })
    },
    refuse: () => {
      for (const listener of refused.slice())
        listener()
    },
    listeners: () => heard.length + refused.length,
  }
}

describe('whenLive pushed', () => {
  // A pause that never ends: reading on an interval would hang.
  const never = async () => new Promise<void>(() => undefined)

  test('is live as soon as the replaced server serves the saved page, with no interval to wait for', async () => {
    const server = pushing()
    const page = pageSaying('old', 'new', 'new')
    const live = whenLive('/talk', { instances: server.instances, pause: never, read: page.read })

    await until(() => server.started === 1)
    server.hear('one')
    await settle()
    expect(page.reads).toEqual(['/talk'])
    server.hear('two')
    expect(await live).toBe(true)
    expect(page.reads).toHaveLength(3)
    expect(server.listeners()).toBe(0)
  })

  test('keeps waiting when the replacing server still shows the old page', async () => {
    const server = pushing()
    const page = pageSaying('old', 'old', 'new', 'new')
    const live = whenLive('/talk', { instances: server.instances, pause: never, read: page.read })

    await until(() => server.started === 1)
    server.hear('one')
    server.hear('two')
    await until(() => page.reads.length === 2)
    server.hear('three')
    expect(await live).toBe(true)
  })

  test('is not live once the window passes with no replacement', async () => {
    const server = pushing()

    expect(await whenLive('/talk', { instances: server.instances, window: 20, pause: never, read: pageSaying('old').read })).toBe(false)
    expect(server.listeners()).toBe(0)
  })

  test('ends with its signal, listening no more', async () => {
    const server = pushing()
    const controller = new AbortController()
    const live = whenLive('/talk', { instances: server.instances, pause: never, read: pageSaying('old').read, signal: controller.signal })

    await until(() => server.started === 1)
    controller.abort()
    expect(await live).toBe(false)
    expect(server.listeners()).toBe(0)
  })

  test('reads on an interval when the server refuses the stream', async () => {
    const server = pushing()
    const page = pageSaying('old', 'old', 'new', 'new')
    const live = whenLive('/talk', { instances: server.instances, ...quick, read: page.read })

    await until(() => server.started === 1)
    server.refuse()
    expect(await live).toBe(true)
  })
})

describe('savedHandler pushed', () => {
  test('turns a save live when the server is replaced, a newer save listening alone', async () => {
    const server = pushing()
    const states: SavedState[] = []
    let finished = 0
    const page = pageSaying('old', 'old', 'new', 'new')
    const saved = savedHandler(() => '/talk', state => states.push(state), () => finished++, { instances: server.instances, read: page.read })

    saved({ rebuilding: true })
    await until(() => server.listeners() === 2)
    saved({ rebuilding: true })
    await until(() => server.listeners() === 2 && page.reads.length === 2)
    server.hear('one')
    server.hear('two')
    await until(() => finished === 1)
    expect(states.at(-1)).toEqual(expect.objectContaining({ rebuilding: false, live: true }))
  })
})
