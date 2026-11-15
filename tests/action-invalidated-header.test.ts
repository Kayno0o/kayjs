import { describe, expect, it } from 'bun:test'
import { invalidatedHeader, liveRefreshMark } from '../src/server/live'

const INVALIDATED = 'x-kay-invalidated'

describe('the keys a call invalidated, named on its answer', () => {
  it('writes them as URL-encoded JSON, so a key outside Latin-1 cannot fail the answer', () => {
    const headers = new Headers()

    invalidatedHeader(new Set(['posts', '日本']), headers, true)
    expect(JSON.parse(decodeURIComponent(headers.get(INVALIDATED)!))).toEqual(['posts', '日本'])
  })

  it('names nothing for a form post, no key, or more keys than a page follows', () => {
    const headers = new Headers()

    invalidatedHeader(new Set(['posts']), headers, false)
    invalidatedHeader(new Set(), headers, true)
    invalidatedHeader(new Set(Array.from({ length: 21 }, (_, index) => `k${index}`)), headers, true)
    expect(headers.has(INVALIDATED)).toBe(false)
  })

  it('marks only a page whose liveRefresh setting is true', () => {
    expect(liveRefreshMark(true)).toContain('data-kay-live-refresh')
    expect(liveRefreshMark(false)).toBe('')
    expect(liveRefreshMark(undefined)).toBe('')
  })
})

describe('the keys an invalidate names, followed or not', () => {
  it('reach the keys a call gathers, so a resource naming one as a tag hears it', async () => {
    const { gatheringInvalidated } = await import('../src/server/live')
    const { invalidate } = await import('../src/runtime/cache')
    const keys = new Set<string>()

    gatheringInvalidated(keys, () => invalidate('posts'))
    expect([...keys]).toEqual(['posts'])
  })
})
