import { describe, expect, test } from 'bun:test'
import { DEFAULT_LIMITS, resolveLimits } from '../src/limits'

describe('rateLimit grouped by feature', () => {
  test('reads each part of a group under the bucket it was a flat key of', () => {
    const limits = resolveLimits({
      signIn: { ip: { max: 9, window: '1h' }, account: [{ max: 2, window: '1m' }, { max: 4, window: '1h' }], accountAll: { max: 50, window: '1h' } },
      forgot: { account: { max: 1, window: '1d' } },
      invite: { address: { max: 2, window: '1d' } },
      oauth: { registerAll: { max: 100, window: '1h' }, token: { max: 7, window: '1m' } },
    })

    expect(limits.signIn[0].max).toBe(9)
    expect(limits.signInAccount.map(({ max }) => max)).toEqual([2, 4])
    expect(limits.signInAccountAll[0].max).toBe(50)
    expect(limits.forgotAccount[0].max).toBe(1)
    expect(limits.forgot[0]).toEqual(DEFAULT_LIMITS.forgot)
    expect(limits.inviteAddress[0].window).toBe('1d')
    expect(limits.oauthRegisterAll?.[0].max).toBe(100)
    expect(limits.oauthToken[0].max).toBe(7)
    expect(limits.oauthRegister[0]).toEqual(DEFAULT_LIMITS.oauthRegister)
  })

  test('a bare limit or a list on a feature with a group is its ip one, as the flat keys were', () => {
    expect(resolveLimits({ signIn: { max: 3, window: '1m' } }).signIn[0].max).toBe(3)
    expect(resolveLimits({ twoFactor: [{ max: 3, window: '1m' }, { max: 8, window: '1h' }] }).twoFactor).toHaveLength(2)
  })

  test('the flat keys of before 1.105 still work', () => {
    expect(resolveLimits({ signInAccount: { max: 2, window: '15m' }, oauthRegisterAll: { max: 5, window: '1h' } }).signInAccount[0].max).toBe(2)
  })

  test('refuses a part the feature has no limit for, naming where it is', () => {
    expect(() => resolveLimits({ signIn: { everyone: { max: 1, window: '1m' } } } as never)).toThrow('rateLimit.signIn.everyone is not a limit of signIn; it has ip, account, accountAll')
    expect(() => resolveLimits({ signIn: { account: { max: 1, window: '-5m' } } })).toThrow('rateLimit.signIn.account.window')
    expect(() => resolveLimits({ oauth: { token: [] } })).toThrow('rateLimit.oauth.token is an empty list')
    expect(() => resolveLimits({ forgot: 3 } as never)).toThrow('rateLimit.forgot is 3; give it { ip, account } or a limit')
  })
})
