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
  test('non-expiring credential passes the stored token through without exchange', async () => {
    const { refresher, calls } = setup({ accessToken: 'gh', expiresAt: null }, async () => null)

    expect(await refresher.getValidToken({ id: 'u1' })).toBe('gh')
    expect(calls()).toBe(0)
  })

  test('a missing access token yields null', async () => {
    const { refresher } = setup({ accessToken: null, expiresAt: Date.now() + MIN }, async () => null)

    expect(await refresher.getValidToken({ id: 'u1' })).toBeNull()
  })

  test('a token still outside the refresh margin is returned as-is', async () => {
    const { refresher, calls } = setup({ accessToken: 'live', expiresAt: Date.now() + 10 * MIN }, async () => null)

    expect(await refresher.getValidToken({ id: 'u1' })).toBe('live')
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

  test('an expiring token with no refresh token yields null', async () => {
    const { refresher, calls } = setup({ accessToken: 'old', expiresAt: Date.now() + 1000 }, async () => null)

    expect(await refresher.getValidToken({ id: 'u1' })).toBeNull()
    expect(calls()).toBe(0)
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
  test('refreshes through the oauth client and persists the new tokens', async () => {
    const expiresAt = Date.now() + 10 * MIN
    const { refresher, saves, errors } = oauthSetup(EXPIRING, async () => ({ accessToken: 'fresh', refreshToken: 'r2', expiresAt }))

    expect(await refresher.getValidToken({ id: 'u1' })).toBe('fresh')
    expect(saves).toEqual([{ accessToken: 'fresh', refreshToken: 'r2', expiresAt }])
    expect(errors).toEqual([])
  })

  test('passes the stored refresh token to the oauth client', async () => {
    let seen: string | undefined
    const { refresher } = oauthSetup(EXPIRING, async (refreshToken) => {
      seen = refreshToken

      return { accessToken: 'fresh', expiresAt: Date.now() + 10 * MIN }
    })

    await refresher.getValidToken({ id: 'u1' })

    expect(seen).toBe('r')
  })

  // The security-relevant default: a credential revoked upstream must not keep granting
  // access until the local session expires.
  test('a rejected refresh clears the stored credential and yields null', async () => {
    const rejection = new OAuthExchangeError(400, 'invalid_grant')
    const { refresher, saves, errors } = oauthSetup(EXPIRING, async () => {
      throw rejection
    })

    expect(await refresher.getValidToken({ id: 'u1' })).toBeNull()
    expect(saves).toEqual([null])
    expect(errors).toEqual([[rejection, 'refresh']])
  })

  test('an outage or a rate limit yields null but keeps the stored credential', async () => {
    for (const failure of [new OAuthExchangeError(503, 'down'), new OAuthExchangeError(429, 'slow down'), new Error('network down')]) {
      const { refresher, saves, errors } = oauthSetup(EXPIRING, async () => {
        throw failure
      })

      expect(await refresher.getValidToken({ id: 'u1' })).toBeNull()
      expect(saves).toEqual([])
      expect(errors).toEqual([[failure, 'refresh']])
    }
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
