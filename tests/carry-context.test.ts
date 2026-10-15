import { describe, expect, it } from 'bun:test'
import { carryContext } from '../src/server/security'

type Set = Parameters<typeof carryContext>[0]

function context(headers: Record<string, string>, extra: Partial<Set> = {}): Set {
  return { headers, status: 200, ...extra }
}

describe('carryContext', () => {
  it('moves the context\'s headers onto the response and empties them, the response\'s own winning', () => {
    const set = context({ 'x-request-id': 'a', 'x-frame-options': 'DENY' })
    const response = carryContext(set, new Response('x', { headers: { 'x-frame-options': 'SAMEORIGIN' } }))

    expect(response.headers.get('x-request-id')).toBe('a')
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    expect(set.headers).toEqual({})
  })

  it('leaves a 201 context over a 200 response to Elysia\'s copy, but not a 200 context', () => {
    const set = context({ 'x-request-id': 'a' }, { status: 201 })
    const response = carryContext(set, new Response('x'))

    expect(response.headers.has('x-request-id')).toBe(false)
    expect(set.headers).toEqual({ 'x-request-id': 'a' })
    expect(set.status).toBe(201)
  })

  it('carries a response whose status the context does not override, and resets the status to 200', () => {
    const set = context({ 'x-request-id': 'a' }, { status: 404 })
    const response = carryContext(set, new Response('x', { status: 404 }))

    expect(response.headers.get('x-request-id')).toBe('a')
    expect(set.status).toBe(200)
  })

  it('leaves a status given as a string to Elysia', () => {
    const set = context({ 'x-request-id': 'a' }, { status: 'Created' as unknown as number })

    expect(carryContext(set, new Response('x')).headers.has('x-request-id')).toBe(false)
  })

  it('leaves a cookie, in the jar or as a header, to Elysia', () => {
    const jar = context({ 'x-request-id': 'a' }, { cookie: {} })
    const header = context({ 'x-request-id': 'a', 'set-cookie': 'a=b' })

    expect(carryContext(jar, new Response('x')).headers.has('x-request-id')).toBe(false)
    expect(carryContext(header, new Response('x')).headers.has('x-request-id')).toBe(false)
    expect(header.headers['x-request-id']).toBe('a')
  })

  it('leaves a chunked response to Elysia, and carries onto a redirect', () => {
    const chunked = context({ 'x-request-id': 'a' })
    const redirect = context({ 'x-request-id': 'a' })

    expect(carryContext(chunked, new Response('x', { headers: { 'transfer-encoding': 'chunked' } })).headers.has('x-request-id')).toBe(false)
    expect(carryContext(redirect, Response.redirect('http://localhost/', 302)).headers.get('x-request-id')).toBe('a')
  })

  it('takes a reused response\'s earlier headers off, even when the next answer is left to Elysia', () => {
    const shared = new Response('x')

    carryContext(context({ 'x-request-id': 'first' }), shared)
    expect(shared.headers.get('x-request-id')).toBe('first')

    carryContext(context({ 'x-request-id': 'second' }, { cookie: {} }), shared)
    expect(shared.headers.has('x-request-id')).toBe(false)

    carryContext(context({ 'x-request-id': 'third' }), shared)
    expect(shared.headers.get('x-request-id')).toBe('third')
  })
})
