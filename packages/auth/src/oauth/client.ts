import type { OAuthClientConfig, OAuthProvider, OAuthTokens } from './types'

interface AuthorizeUrlOptions {
  state?: string
  /** PKCE code challenge (S256); pair with `codeVerifier` on `exchangeCode`. */
  codeChallenge?: string
  extraParams?: Record<string, string>
}

/** Caps a provider response body embedded in an error so tokens/PII don't leak into logs. */
function redactBody(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}...` : text
}

/**
 * Thrown when the provider rejects the token exchange or user fetch - a bad/expired
 * authorization code, or the provider being down. `status` is the upstream HTTP status,
 * so a caller can answer a client's bad code with a 4xx and a provider outage with a 502.
 */
export class OAuthExchangeError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'OAuthExchangeError'
  }
}

/** A configured OAuth client bound to one provider and one app's credentials. */
export function createOAuthClient<Raw = any, User = unknown>(provider: OAuthProvider<Raw, User>, config: OAuthClientConfig) {
  return {
    /** The provider authorize URL to redirect the user to. */
    authorizeUrl({ state, codeChallenge, extraParams }: AuthorizeUrlOptions = {}): string {
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: 'code',
        scope: provider.scopes.join(provider.scopeSeparator ?? ' '),
        ...extraParams,
      })

      if (state !== undefined)
        params.set('state', state)

      if (codeChallenge !== undefined) {
        params.set('code_challenge', codeChallenge)
        params.set('code_challenge_method', 'S256')
      }

      return `${provider.authorizeUrl}?${params}`
    },

    /** Exchanges an authorization code for tokens (replay the PKCE `codeVerifier` if used). */
    async exchangeCode(code: string, opts: { codeVerifier?: string } = {}): Promise<OAuthTokens> {
      const body = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.redirectUri,
      })

      if (opts.codeVerifier !== undefined)
        body.set('code_verifier', opts.codeVerifier)

      return provider.parseTokens(await postToken(provider, body))
    },

    /** Refreshes tokens with a refresh token. */
    async refreshTokens(refreshToken: string): Promise<OAuthTokens> {
      return provider.parseTokens(await postToken(provider, new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      })))
    },

    /** Fetches and normalizes the provider user. */
    async fetchUser(accessToken: string): Promise<User> {
      const res = await fetch(provider.userUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...provider.authHeaders?.(accessToken),
        },
      })

      if (!res.ok)
        throw new OAuthExchangeError(res.status, `OAuth user fetch failed (${provider.name}): ${res.status} ${redactBody(await res.text())}`)

      return provider.normalizeUser(await res.json() as Raw)
    },
  }
}

async function postToken(provider: OAuthProvider<any, any>, body: URLSearchParams): Promise<any> {
  const res = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body,
  })

  const text = await res.text()

  if (!res.ok)
    throw new OAuthExchangeError(res.status, `OAuth token request failed (${provider.name}): ${res.status} ${redactBody(text)}`)

  const isJson = provider.tokenAccept === 'json'
    || (provider.tokenAccept !== 'form' && (res.headers.get('content-type') ?? '').includes('json'))

  return isJson ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text))
}
