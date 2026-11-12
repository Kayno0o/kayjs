import type { RateLimitRefusal } from 'kay'
import { describe, expect, test } from 'bun:test'
import { rateLimit } from 'kay/server'
import { reached, resolveLimits, spend, tally } from '../src/limits'
import { authLimiters } from '../src/rates'

describe('onLimit on an auth limit', () => {
  test('is told of each attempt spend refuses, under the key it counted', async () => {
    const seen: RateLimitRefusal[] = []
    const { signIn } = resolveLimits({ signIn: { max: 1, window: '1m', onLimit: refusal => void seen.push(refusal) } })
    const rates = authLimiters({} as never)

    expect(await spend(rates, 'sign-in:a', signIn)).toBe(false)
    expect(seen).toHaveLength(0)
    expect(await spend(rates, 'sign-in:a', signIn)).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ name: 'kayjs-auth', key: 'sign-in:a' })
    expect(seen[0]!.wait).toBeGreaterThan(0)
  })

  test('is told once per refused attempt, whatever the number of limits it is over, with the longest wait', async () => {
    const seen: RateLimitRefusal[] = []
    const onLimit = (refusal: RateLimitRefusal) => void seen.push(refusal)
    const { signIn } = resolveLimits({ signIn: [{ max: 1, window: '1m', onLimit }, { max: 1, window: '1h', onLimit }] })
    const rates = authLimiters({} as never)

    await spend(rates, 'many', signIn)
    expect(await spend(rates, 'many', signIn)).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.wait).toBeGreaterThan(60)
  })

  test('is told once by a lockout check that reads a limit at its max, and never by one under it', async () => {
    const seen: RateLimitRefusal[] = []
    const { signIn } = resolveLimits({ signIn: { max: 2, window: '1m', onLimit: refusal => void seen.push(refusal) } })
    const rates = authLimiters({} as never)

    await tally(rates, 'failures', signIn)
    expect(await reached(rates, 'failures', signIn)).toBe(false)
    expect(seen).toHaveLength(0)
    await tally(rates, 'failures', signIn)
    expect(await reached(rates, 'failures', signIn)).toBe(true)
    expect(seen).toHaveLength(1)
  })

  test('is left to the caller by tally, which only names the limit the attempt is over', async () => {
    const seen: RateLimitRefusal[] = []
    const { signIn } = resolveLimits({ signIn: [{ max: 1, window: '1m', onLimit: refusal => void seen.push(refusal) }, { max: 1, window: '1h' }] })
    const rates = authLimiters({} as never)

    expect((await tally(rates, 'guess', signIn)).over).toBeUndefined()

    const { over, beside } = await tally(rates, 'guess', signIn)

    expect(beside).toBe(true)
    expect(over?.wait).toBeGreaterThan(60)
    expect(seen).toHaveLength(0)
  })

  test('is refused when it is no function, as is a rateLimit() object', () => {
    expect(() => resolveLimits({ signIn: { max: 1, window: '1m', onLimit: 'log' as never } })).toThrow('onLimit')
    expect(() => resolveLimits({ signIn: rateLimit('shared', { max: 1, window: '1m' }) as never })).toThrow('rateLimit() object')
  })
})
