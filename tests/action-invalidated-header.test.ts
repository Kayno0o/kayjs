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

describe('the keys an invalidate names', () => {
  const named = async (asked: string[], run: (invalidate: (key: string) => void) => void) => {
    const { gatheringInvalidated, askedKeys } = await import('../src/server/live')
    const { invalidate } = await import('../src/runtime/cache')
    const keys = new Set<string>()
    const request = new Request('http://localhost/', { headers: { 'x-kay-tags': encodeURIComponent(JSON.stringify(asked)) } })

    gatheringInvalidated(keys, () => run(invalidate), askedKeys(request))

    return keys
  }

  it('reach the call only when its page asked for them, so a key it never named stays out', async () => {
    expect([...await named(['posts'], invalidate => invalidate('posts'))]).toEqual(['posts'])
    expect([...await named(['posts'], invalidate => invalidate('admin:1'))]).toEqual([])
    expect([...await named([], invalidate => invalidate('posts'))]).toEqual([])
  })

  it('still give the header when 25 keys were named and 2 of them were asked for', async () => {
    const keys = await named(['k3', 'k9'], (invalidate) => {
      for (let index = 0; index < 25; index++)
        invalidate(`k${index}`)
    })
    const headers = new Headers()

    invalidatedHeader(keys, headers, true)
    expect(JSON.parse(decodeURIComponent(headers.get(INVALIDATED)!))).toEqual(['k3', 'k9'])
  })

  it('ignore a tags header that does not read', async () => {
    const { askedKeys } = await import('../src/server/live')

    expect([...askedKeys(new Request('http://localhost/', { headers: { 'x-kay-tags': '%zz' } }))]).toEqual([])
    expect([...askedKeys(new Request('http://localhost/', { headers: { 'x-kay-tags': encodeURIComponent('{"a":1}') } }))]).toEqual([])
  })
})
