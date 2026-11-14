import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { CACHE_LIVE_ID } from '../src/runtime/cache-live-id'
import { encodeValue } from '../src/runtime/wire'

let cache: typeof import('../src/runtime/live-cache')

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/page' })
  // The connection stays open and sends nothing.
  spyOn(globalThis, 'fetch').mockImplementation((async () => new Promise<Response>(() => undefined)) as unknown as typeof fetch)
  cache = await import('../src/runtime/live-cache')
})

afterAll(async () => {
  document.body.innerHTML = ''
  cache.followCaches()
  await GlobalRegistrator.unregister()
})

function page(keys: string[], optedIn: boolean): void {
  const page = { values: keys.map(key => [CACHE_LIVE_ID, key, 1]), at: Date.now(), sig: 'x' }

  document.body.innerHTML = `<script type="application/json" data-kay-live data-kay-cache>${encodeValue(page)}</script>${optedIn ? '<script type="application/json" data-kay-live-refresh></script>' : ''}`
  cache.followCaches()
}

describe('whether a call leaves the page to its live connection', () => {
  beforeEach(() => page(['posts', 'tags'], true))

  it('does when the page opted in and follows every key the call invalidated', () => {
    expect(cache.follows(['posts'])).toBe(true)
    expect(cache.follows(['posts', 'tags'])).toBe(true)
  })

  it('does not when one key is not followed', () => {
    expect(cache.follows(['posts', 'count'])).toBe(false)
  })

  it('does not for a page that did not opt in, whatever it follows', () => {
    page(['posts'], false)
    expect(cache.follows(['posts'])).toBe(false)
  })
})
