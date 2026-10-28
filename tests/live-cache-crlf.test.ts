import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { CACHE_LIVE_ID } from '../src/runtime/cache-live-id'
import { encodeValue } from '../src/runtime/wire'

// Past the longest random wait before a resource asks its route again.
const REFETCH_MS = 3000
const realFetch = globalThis.fetch
let followRoute: typeof import('../src/runtime/live-cache').followRoute
let chunks: string[] = []

async function until(condition: () => boolean): Promise<void> {
  for (const start = Date.now(); !condition(); await Bun.sleep(5)) {
    if (Date.now() - start > REFETCH_MS)
      throw new Error('timed out')
  }
}

// Whether a resource that read `orders` at 1 asks its route again once the connection sends `chunks`, the invalidation at 2 they carry.
async function refetchesOn(sent: string[]): Promise<boolean> {
  const owner = {}
  let refetched = false

  chunks = sent
  followRoute(owner, encodeURIComponent(encodeValue({ at: Date.now(), sig: 'proof', values: [[CACHE_LIVE_ID, 'orders', 1]] })), () => {
    refetched = true
  })

  try {
    await until(() => refetched)

    return true
  }
  catch {
    return false
  }
  finally {
    followRoute(owner, null, () => undefined)
  }
}

const EVENT = `data: ${encodeValue([[CACHE_LIVE_ID, 'orders', 2]])}`

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  // The connection's answer: the chunks of the test running, then open until the page lets go of it.
  globalThis.fetch = (async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks)
          controller.enqueue(encoder.encode(chunk))
      },
    })

    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  followRoute = (await import('../src/runtime/live-cache')).followRoute
})

afterAll(async () => {
  globalThis.fetch = realFetch
  await GlobalRegistrator.unregister()
})

describe('the reader of cached values a page follows', () => {
  it('delivers an event whose line breaks a proxy rewrote to \\r\\n', async () => {
    expect(await refetchesOn([`: open\r\n\r\n${EVENT}\r\n\r\n`])).toBe(true)
  })

  it('delivers an event whose \\r\\n is split across two chunks', async () => {
    expect(await refetchesOn([`${EVENT}\r\n\r`, '\n'])).toBe(true)
  })

  it('still delivers an event ending in \\n\\n', async () => {
    expect(await refetchesOn([`${EVENT}\n\n`])).toBe(true)
  })
})
