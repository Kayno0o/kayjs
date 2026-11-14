import { describe, expect, it } from 'bun:test'
import { invalidatedHeader } from '../src/server/live'

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
})
