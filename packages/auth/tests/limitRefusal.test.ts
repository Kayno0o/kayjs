import type { RateLimitRefusal } from 'kay'
import { describe, expect, test } from 'bun:test'
import { rateLimit } from 'kay/server'
import { resolveLimits, spend } from '../src/limits'
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

  test('is refused when it is no function, as is a rateLimit() object', () => {
    expect(() => resolveLimits({ signIn: { max: 1, window: '1m', onLimit: 'log' as never } })).toThrow('onLimit')
    expect(() => resolveLimits({ signIn: rateLimit('shared', { max: 1, window: '1m' }) as never })).toThrow('rateLimit() object')
  })
})
