import type { RateLimitRefusal } from 'kay'
import { describe, expect, it, spyOn } from 'bun:test'
import { memoryRates, rateLimit } from 'kay/server'
import { apiLimitWait, protectionRefusal } from '../src/server/protection'

const refusalOptions = { body: {}, form: false, server: null, plain: false }
const request = (headers: Record<string, string> = {}) => new Request('http://localhost/', { method: 'POST', headers })

// A guard's context as far as `enforce` reads it: `deny` throws as kay's does.
function guardContext(from: Request) {
  const headers = new Headers()
  const denied: { status?: number, message?: string } = {}

  return {
    ctx: {
      request: from,
      headers,
      locale: 'en',
      cookies: {},
      locals: {},
      deny: (status?: number, message?: string): never => {
        Object.assign(denied, { status, message })

        throw new Error('denied')
      },
    } as never,
    headers,
    denied,
  }
}

describe('enforce', () => {
  it('lets a request under the limit through and denies the one past it with 429 and Retry-After', async () => {
    const limit = rateLimit('enforce-basic', { max: 1, window: '1m', store: memoryRates() })
    const first = guardContext(request())

    await limit.enforce(first.ctx)
    expect(first.headers.get('retry-after')).toBeNull()

    const second = guardContext(request())

    await expect(limit.enforce(second.ctx)).rejects.toThrow('denied')
    expect(second.denied.status).toBe(429)
    expect(second.denied.message).toContain('try again')
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('takes the message as a text or a function of the wait', async () => {
    const limit = rateLimit('enforce-message', { max: 1, window: '1m', store: memoryRates() })

    await limit.enforce(guardContext(request()).ctx)

    const slow = guardContext(request())

    await expect(limit.enforce(slow.ctx, wait => `wait ${wait > 0}`)).rejects.toThrow('denied')
    expect(slow.denied.message).toBe('wait true')

    const text = guardContext(request())

    await expect(limit.enforce(text.ctx, 'Slow down')).rejects.toThrow('denied')
    expect(text.denied.message).toBe('Slow down')
  })

  it('counts under the limit key when it has one', async () => {
    const limit = rateLimit('enforce-key', { max: 1, window: '1m', store: memoryRates(), key: ctx => ctx.request.headers.get('x-user') ?? undefined })

    await limit.enforce(guardContext(request({ 'x-user': 'ada' })).ctx)
    await limit.enforce(guardContext(request({ 'x-user': 'grace' })).ctx)
    await expect(limit.enforce(guardContext(request({ 'x-user': 'ada' })).ctx)).rejects.toThrow('denied')
  })
})

describe('a limit object shared with an action', () => {
  it('counts the action and the guard in one counter', async () => {
    const limit = rateLimit('shared-guard', { max: 2, window: '1m', store: memoryRates() })
    const action = { url: '/_kay/action/shared', protection: { rateLimit: limit } } as never

    await limit.enforce(guardContext(request()).ctx)
    expect(await protectionRefusal(action, request(), refusalOptions)).toBeUndefined()
    expect(await protectionRefusal(action, request(), refusalOptions)).toMatchObject({ status: 429 })
    await expect(limit.enforce(guardContext(request()).ctx)).rejects.toThrow('denied')
  })

  it('counts an API route using the same object with them', async () => {
    const limit = rateLimit('shared-api', { max: 2, window: '1m', store: memoryRates() })
    const action = { url: '/_kay/action/shared-api', protection: { rateLimit: limit } } as never
    const route = [{ name: 'GET /thing', limit }]
    const context = () => ({ request: request(), locale: 'en', cookies: {}, locals: {} }) as never

    expect(await protectionRefusal(action, request(), refusalOptions)).toBeUndefined()
    expect(await apiLimitWait(route, request(), null, context)).toBeUndefined()
    expect(await apiLimitWait(route, request(), null, context)).toBeGreaterThan(0)
    expect(await protectionRefusal(action, request(), refusalOptions)).toMatchObject({ status: 429 })
  })

  it('keeps a plain options object counting as before, apart from the shared one', async () => {
    const limit = rateLimit('shared-apart', { max: 1, window: '1m', store: memoryRates() })
    const plain = { url: '/_kay/action/plain', protection: { rateLimit: { max: 1, window: '1m' } } } as never

    await limit.enforce(guardContext(request()).ctx)
    expect(await protectionRefusal(plain, request(), refusalOptions)).toBeUndefined()
    expect(await protectionRefusal(plain, request(), refusalOptions)).toMatchObject({ status: 429 })
  })
})

describe('onLimit', () => {
  it('is told of each refusal of an action, a guard and an API route, never of one let through', async () => {
    const seen: RateLimitRefusal[] = []
    const onLimit = (refusal: RateLimitRefusal) => void seen.push(refusal)
    const limit = rateLimit('on-limit', { max: 1, window: '1m', store: memoryRates(), onLimit })
    const action = { url: '/_kay/action/on-limit', protection: { rateLimit: limit } } as never
    const route = [{ name: 'GET /limited', limit: { max: 1, window: '1m' as const, store: memoryRates(), onLimit } }]
    const context = () => ({ request: request(), locale: 'en', cookies: {}, locals: {} }) as never

    expect(await protectionRefusal(action, request(), refusalOptions)).toBeUndefined()
    expect(seen).toHaveLength(0)
    await protectionRefusal(action, request(), refusalOptions)
    expect(seen.at(-1)).toMatchObject({ name: '/_kay/action/on-limit', wait: expect.any(Number) as number })
    expect(seen.at(-1)?.request).toBeInstanceOf(Request)

    await expect(limit.enforce(guardContext(request()).ctx)).rejects.toThrow('denied')
    expect(seen).toHaveLength(2)

    await apiLimitWait(route, request(), null, context)
    expect(seen).toHaveLength(2)
    await apiLimitWait(route, request(), null, context)
    expect(seen.at(-1)).toMatchObject({ name: 'GET /limited' })
    expect(seen).toHaveLength(3)

    expect(await limit.hit('account')).toBeUndefined()
    expect(await limit.hit('account')).toBeGreaterThan(0)
    expect(seen.at(-1)).toMatchObject({ key: 'key:account' })
    expect(seen.at(-1)?.request).toBeUndefined()
  })

  it('never fails the refusal when it throws or rejects, and logs it', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)

    const throwing = () => {
      throw new Error('boom')
    }

    try {
      for (const onLimit of [throwing, async () => Promise.reject(new Error('later'))]) {
        const limit = rateLimit('on-limit-throws', { max: 1, window: '1m', store: memoryRates(), onLimit })
        const action = { url: '/_kay/action/throws', protection: { rateLimit: limit } } as never

        await protectionRefusal(action, request(), refusalOptions)
        expect(await protectionRefusal(action, request(), refusalOptions)).toMatchObject({ status: 429 })
      }

      await Bun.sleep(5)
      expect(warn).toHaveBeenCalled()
    }
    finally {
      warn.mockRestore()
    }
  })
})
