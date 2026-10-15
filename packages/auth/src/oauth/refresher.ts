import type { OAuthTokens } from './types'
import { MINUTE_MS } from '@kaynooo/utils'
import { OAuthExchangeError } from './client'

// The answers by which a provider refuses the refresh token itself; anything else, an outage or a rate limit, may pass.
const REFUSED_STATUSES = new Set([400, 401])

/** The currently-stored credential for a subject; `expiresAt` null/undefined = non-expiring. */
export interface StoredCredential {
  accessToken?: string | null | undefined
  refreshToken?: string | null | undefined
  expiresAt?: number | null | undefined
}

export interface TokenRefresherDeps<K, S> {
  /** Cache key for a subject (e.g. the user's id). */
  key: (subject: S) => K
  /** Reads the subject's stored credential. */
  load: (subject: S) => StoredCredential
  /** Performs the refresh + persistence; returns the new token, or `null` when refresh failed. */
  exchange: (subject: S) => Promise<{ accessToken: string, expiresAt?: number | undefined } | null>
  /** How long before expiry to refresh (default 5 min). */
  marginMs?: number | undefined
}

/** Wraps a token `exchange` with per-subject caching + in-flight dedup; non-expiring credentials pass through. Feeds `GrantStore.hasCredential` (non-null = live). */
export function createTokenRefresher<K, S>(deps: TokenRefresherDeps<K, S>) {
  const margin = deps.marginMs ?? 5 * MINUTE_MS
  const cache = new Map<K, { accessToken: string, expiresAt: number }>()
  const inFlight = new Map<K, Promise<string | null>>()

  return {
    async getValidToken(subject: S): Promise<string | null> {
      const stored = deps.load(subject)

      if (stored.accessToken == null || stored.accessToken === '')
        return null

      if (stored.expiresAt === undefined || stored.expiresAt === null)
        return stored.accessToken

      const now = Date.now()
      const key = deps.key(subject)
      const cached = cache.get(key)

      if (cached && cached.expiresAt > now + margin)
        return cached.accessToken

      if (cached && cached.expiresAt <= now)
        cache.delete(key)

      if (stored.expiresAt > now + margin)
        return stored.accessToken

      if (stored.refreshToken == null || stored.refreshToken === '')
        return null

      const existing = inFlight.get(key)

      if (existing)
        return existing

      const refresh = (async (): Promise<string | null> => {
        try {
          const result = await deps.exchange(subject)

          if (!result) {
            cache.delete(key)

            return null
          }

          // Entries past their expiry are never read again, so they go as a new one comes.
          for (const [other, entry] of cache) {
            if (entry.expiresAt <= Date.now())
              cache.delete(other)
          }

          if (result.expiresAt !== undefined)
            cache.set(key, { accessToken: result.accessToken, expiresAt: result.expiresAt })

          return result.accessToken
        }
        catch (err) {
          cache.delete(key)

          throw err
        }
        finally {
          inFlight.delete(key)
        }
      })()

      inFlight.set(key, refresh)

      return refresh
    },
  }
}

/** The `createOAuthClient` slice `createOAuthTokenRefresher` drives. */
export interface RefreshableOAuthClient {
  refreshTokens: (refreshToken: string) => Promise<OAuthTokens>
}

/** Which step failed, for `onError` reporting. */
export type RefreshStage = 'refresh' | 'persist' | 'revoke'

export interface OAuthTokenRefresherDeps<K, S> {
  /** The configured client performing the refresh (`createOAuthClient(provider, config)`). */
  oauth: RefreshableOAuthClient
  /** Cache key for a subject (e.g. the user's id). */
  key: (subject: S) => K
  /** Reads the subject's stored credential. */
  load: (subject: S) => StoredCredential
  /** Persists the outcome. `tokens` is `null` when the provider refused the refresh token, the credential revoked upstream: write nulls so the stale access token stops being treated as live. Keep `refreshToken` when a rotation response omits it. */
  save: (subject: S, tokens: OAuthTokens | null) => Promise<void>
  /** Notified when a step throws; the refresher itself never rejects. */
  onError?: ((error: unknown, stage: RefreshStage) => void) | undefined
  /** How long before expiry to refresh (default 5 min). */
  marginMs?: number | undefined
}

/**
 * `createTokenRefresher` bound to an OAuth client: refreshes through `oauth.refreshTokens` and persists via `save`, so consumers supply field mapping only.
 *
 * A refresh the provider refuses (a 400 or a 401) calls `save(subject, null)` rather than leaving the old credential in place, since a token revoked at the provider would otherwise keep granting access. Any other failure yields null for now and keeps the credential.
 * A `save` failure after a successful refresh is reported but not fatal: the token is valid, and the refresher's cache carries it until the next write succeeds.
 */
export function createOAuthTokenRefresher<K, S>(deps: OAuthTokenRefresherDeps<K, S>) {
  return createTokenRefresher<K, S>({
    key: deps.key,
    load: deps.load,
    marginMs: deps.marginMs,
    exchange: async (subject) => {
      const refreshToken = deps.load(subject).refreshToken

      if (refreshToken == null || refreshToken === '')
        return null

      let tokens: OAuthTokens

      try {
        tokens = await deps.oauth.refreshTokens(refreshToken)
      }
      catch (error) {
        deps.onError?.(error, 'refresh')

        // Kept through an outage, and through a race another process won with a rotated token: only a refusal forgets them.
        if (!(error instanceof OAuthExchangeError && REFUSED_STATUSES.has(error.status)))
          return null

        try {
          await deps.save(subject, null)
        }
        catch (revokeError) {
          deps.onError?.(revokeError, 'revoke')
        }

        return null
      }

      try {
        await deps.save(subject, tokens)
      }
      catch (error) {
        deps.onError?.(error, 'persist')
      }

      return { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt }
    },
  })
}
