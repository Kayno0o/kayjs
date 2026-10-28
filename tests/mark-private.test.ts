import { describe, expect, it } from 'bun:test'
import { markPrivate } from '../src/server/scope'

describe('markPrivate', () => {
  it('marks Headers private and adds cookie to their vary once', () => {
    const headers = new Headers({ vary: 'accept-encoding' })

    markPrivate(headers)
    expect(headers.get('cache-control')).toBe('private, no-cache')
    expect(headers.get('vary')).toBe('accept-encoding, cookie')

    const varied = new Headers({ vary: 'Cookie' })

    markPrivate(varied)
    expect(varied.get('vary')).toBe('Cookie')
  })

  it('marks the record of Elysia\'s context the same way, whatever case its names are in', () => {
    const headers: Record<string, unknown> = { Vary: ['Save-Data', 'accept-encoding'] }

    markPrivate(headers)
    expect(headers).toEqual({ 'cache-control': 'private, no-cache', 'Vary': 'Save-Data, accept-encoding, cookie' })

    const bare: Record<string, unknown> = {}

    markPrivate(bare)
    expect(bare).toEqual({ 'cache-control': 'private, no-cache', 'vary': 'cookie' })
  })

  it('leaves an answer that set its own caching alone', () => {
    const headers = new Headers({ 'cache-control': 'public, max-age=60' })
    const record: Record<string, unknown> = { 'Cache-Control': 'no-store' }

    markPrivate(headers)
    markPrivate(record)
    expect([...headers]).toEqual([['cache-control', 'public, max-age=60']])
    expect(record).toEqual({ 'Cache-Control': 'no-store' })
  })
})
