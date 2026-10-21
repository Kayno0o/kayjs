import type { RefreshStage, StoredCredential } from '../src/oauth/refresher'
import type { OAuthTokens } from '../src/oauth/types'
import { describe, expect, test } from 'bun:test'
import { OAuthExchangeError } from '../src/oauth/client'
import { createOAuthTokenRefresher, createTokenRefresher } from '../src/oauth/refresher'

const MIN = 60_000

interface Subject { id: string }

function setup(stored: StoredCredential, exchange: () => Promise<{ accessToken: string, expiresAt?: number } | null>) {
  let calls = 0
  const refresher = createTokenRefresher<string, Subject>({
    key: s => s.id,
    load: () => stored,
    exchange: async () => {
      calls++

      return exchange()
    },
  })

  return { refresher, calls: () => calls }
}

describe('createTokenRefresher', () => {
  // Credentials the refresher answers from what is stored, never reaching the exchange.
  test.each<[string, StoredCredential, string | null]>([
    ['a non-expiring credential passes the stored token through', { accessToken: 'gh', expiresAt: null }, 'gh'],
    ['a missing access token yields null', { accessToken: null, expiresAt: Date.now() + MIN }, null],
    ['a token still outside the refresh margin is returned as-is', { accessToken: 'live', expiresAt: Date.now() + 10 * MIN }, 'live'],
    ['an expiring token with no refresh token yields null', { accessToken: 'old', expiresAt: Date.now() + 1000 }, null],
  ])('%s without an exchange', async (_name, stored, token) => {
    const { refresher, calls } = setup(stored, async () => null)

    expect(await refresher.getValidToken({ id: 'u1' })).toBe(token)
    expect(calls()).toBe(0)
  })

  test('an expiring token with a refresh token is exchanged and cached', async () => {
    const { refresher, calls } = setup(
      { accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() + 1000 },
      async () => ({ accessToken: 'fresh', expiresAt: Date.now() + 10 * MIN }),
    )

    expect(await refresher.getValidToken({ id: 'u1' })).toBe('fresh')
    // Second call is served from cache, so no second exchange.
    expect(await refresher.getValidToken({ id: 'u1' })).toBe('fresh')
    expect(calls()).toBe(1)
  })

  test('margin is a duration, and the marginMs of before 1.70 still reads', async () => {
    const stored: StoredCredential = { accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() + 10 * MIN }

    for (const margin of [{ margin: '15m' as const }, { marginMs: 15 * MIN }]) {
      const refresher = createTokenRefresher<string, Subject>({ key: s => s.id, load: () => stored, exchange: async () => ({ accessToken: 'fresh', expiresAt: Date.now() + 60 * MIN }), ...margin })

      expect(await refresher.getValidToken({ id: 'u1' })).toBe('fresh')
    }
  })

  test('a failed refresh yields null and does not cache', async () => {
    const stored: StoredCredential = { accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() + 1000 }
    const { refresher, calls } = setup(stored, async () => null)

    expect(await refresher.getValidToken({ id: 'u1' })).toBeNull()
    expect(await refresher.getValidToken({ id: 'u1' })).toBeNull()
    expect(calls()).toBe(2)
  })

  test('an exception during refresh propagates and does not cache', async () => {
    const { refresher, calls } = setup(
      { accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() + 1000 },
      async () => { throw new Error('network down') },
    )

    await expect(refresher.getValidToken({ id: 'u1' })).rejects.toThrow('network down')
    // A later call retries (nothing was cached).
    await expect(refresher.getValidToken({ id: 'u1' })).rejects.toThrow('network down')
    expect(calls()).toBe(2)
  })

  test('concurrent refreshes for the same subject dedup to one exchange', async () => {
    let resolve!: (v: { accessToken: string, expiresAt?: number }) => void
    const gate = new Promise<{ accessToken: string, expiresAt?: number }>((r) => {
      resolve = r
    })
    const { refresher, calls } = setup(
      { accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() + 1000 },
      async () => gate,
    )

    const a = refresher.getValidToken({ id: 'u1' })
    const b = refresher.getValidToken({ id: 'u1' })

    resolve({ accessToken: 'fresh', expiresAt: Date.now() + 10 * MIN })

    expect(await a).toBe('fresh')
    expect(await b).toBe('fresh')
    expect(calls()).toBe(1)
  })
})

function oauthSetup(stored: StoredCredential, refreshTokens: (refreshToken: string) => Promise<OAuthTokens>, saveImpl?: () => void) {
  const saves: (OAuthTokens | null)[] = []
  const errors: [unknown, RefreshStage][] = []
  const refresher = createOAuthTokenRefresher<string, Subject>({
    oauth: { refreshTokens },
    key: s => s.id,
    load: () => stored,
    save: async (_subject, tokens) => {
      saves.push(tokens)
      saveImpl?.()
    },
    onError: (error, stage) => errors.push([error, stage]),
  })

  return { refresher, saves, errors }
}

const EXPIRING: StoredCredential = { accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() + 1000 }

describe('createOAuthTokenRefresher', () => {
  test('refreshes through the oauth client with the stored refresh token and persists the new tokens', async () => {
    const expiresAt = Date.now() + 10 * MIN
    const seen: string[] = []
    const { refresher, saves, errors } = oauthSetup(EXPIRING, async (refreshToken) => {
      seen.push(refreshToken)

      return { accessToken: 'fresh', refreshToken: 'r2', expiresAt }
    })

    expect(await refresher.getValidToken({ id: 'u1' })).toBe('fresh')
    expect(seen).toEqual(['r'])
    expect(saves).toEqual([{ accessToken: 'fresh', refreshToken: 'r2', expiresAt }])
    expect(errors).toEqual([])
  })

  // The security-relevant default: a credential revoked upstream must not keep granting access until the local session expires, while an outage or a rate limit must not forget a credential that is fine.
  test.each([
    ['a 400 refusal yields null and clears the credential', new OAuthExchangeError(400, 'invalid_grant'), true],
    ['a 401 refusal yields null and clears the credential', new OAuthExchangeError(401, 'invalid_client'), true],
    ['a 503 outage yields null and keeps the credential', new OAuthExchangeError(503, 'down'), false],
    ['a 429 rate limit yields null and keeps the credential', new OAuthExchangeError(429, 'slow down'), false],
    ['a network error yields null and keeps the credential', new Error('network down'), false],
  ])('%s', async (_name, failure, clears) => {
    const { refresher, saves, errors } = oauthSetup(EXPIRING, async () => {
      throw failure
    })

    expect(await refresher.getValidToken({ id: 'u1' })).toBeNull()
    expect(saves).toEqual(clears ? [null] : [])
    expect(errors).toEqual([[failure, 'refresh']])
  })

  test('a refresh the provider timed out on leaves none pending, so the next call asks again', async () => {
    let calls = 0
    const { refresher } = oauthSetup(EXPIRING, async () => {
      calls++

      if (calls === 1)
        throw new OAuthExchangeError(502, 'OAuth token request failed (discord): The operation timed out.')

      return { accessToken: 'fresh', expiresAt: Date.now() + 10 * MIN }
    })

    expect(await refresher.getValidToken({ id: 'u1' })).toBeNull()
    expect(await refresher.getValidToken({ id: 'u1' })).toBe('fresh')
    expect(calls).toBe(2)
  })

  test('a persistence failure after a successful refresh is reported but keeps the valid token', async () => {
    const writeError = new Error('db down')
    const { refresher, errors } = oauthSetup(
      EXPIRING,
      async () => ({ accessToken: 'fresh', expiresAt: Date.now() + 10 * MIN }),
      () => { throw writeError },
    )

    expect(await refresher.getValidToken({ id: 'u1' })).toBe('fresh')
    expect(errors).toEqual([[writeError, 'persist']])
  })

  test('a failed revoke write is reported and still yields null', async () => {
    const rejection = new OAuthExchangeError(400, 'invalid_grant')
    const writeError = new Error('db down')
    const { refresher, errors } = oauthSetup(EXPIRING, async () => {
      throw rejection
    }, () => {
      throw writeError
    })

    expect(await refresher.getValidToken({ id: 'u1' })).toBeNull()
    expect(errors).toEqual([[rejection, 'refresh'], [writeError, 'revoke']])
  })

  test('a credential with no refresh token never reaches the oauth client', async () => {
    let called = false
    const { refresher, saves } = oauthSetup({ accessToken: 'old', expiresAt: Date.now() + 1000 }, async () => {
      called = true

      return { accessToken: 'fresh' }
    })

    expect(await refresher.getValidToken({ id: 'u1' })).toBeNull()
    expect(called).toBe(false)
    expect(saves).toEqual([])
  })
})
