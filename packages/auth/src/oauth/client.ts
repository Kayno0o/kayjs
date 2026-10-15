import type { JWTVerifyGetKey } from 'jose'
import type { OAuthClientConfig, OAuthEndpoints, OAuthProvider, OAuthTokens, OpenIdCheck } from './types'
import { PROVIDER_TIMEOUT_MS } from './timeout'

// How far apart the provider's clock and this one may be when an ID token's times are read.
const CLOCK_TOLERANCE_S = 60

// What an ID token may be signed with when the provider names no list: asymmetric algorithms only, so neither `none` nor a shared-secret one passes.
const ID_TOKEN_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA']

interface AuthorizeUrlOptions {
  state?: string
  /** PKCE code challenge (S256); pair with `codeVerifier` on `exchangeCode`. */
  codeChallenge?: string
  /** Sent to an OpenID Connect provider only, to find in the ID token on `readUser`. */
  nonce?: string
  extraParams?: Record<string, string>
}

/** Caps a provider response body embedded in an error so tokens/PII don't leak into logs. */
function redactBody(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}...` : text
}

/** Thrown when the provider rejects the token exchange or user fetch, a bad or expired authorization code or the provider being down. `status` is the upstream HTTP status, so a caller can answer a client's bad code with a 4xx and a provider outage with a 502. */
export class OAuthExchangeError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'OAuthExchangeError'
  }
}

/** A configured OAuth client bound to one provider and one app's credentials. */
export function createOAuthClient<Raw = unknown, User = unknown>(provider: OAuthProvider<Raw, User>, config: OAuthClientConfig) {
  let discovered: Promise<OAuthEndpoints> | undefined
  const keySets = new Map<string, JWTVerifyGetKey>()

  // Discovered once; a failure is tried again on the next use rather than kept.
  const endpoints = async (): Promise<OAuthEndpoints> => {
    if (!provider.discover)
      return provider

    discovered ??= provider.discover()

    try {
      return { ...provider, ...await discovered }
    }
    catch (error) {
      discovered = undefined

      throw new OAuthExchangeError(502, `OAuth discovery failed (${provider.name}): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const endpoint = async (name: 'authorizeUrl' | 'tokenUrl'): Promise<string> => {
    const url = (await endpoints())[name]

    if (url === undefined)
      throw new Error(`kayjs-auth: the ${provider.name} provider has no ${name}`)

    return url
  }

  const withCredentials = async (body: URLSearchParams): Promise<URLSearchParams> => {
    const secret = provider.clientSecret ? await provider.clientSecret(config.clientId) : config.clientSecret

    body.set('client_id', config.clientId)

    if (secret !== undefined)
      body.set('client_secret', secret)

    return body
  }

  const userInfo = async (accessToken: string, userUrl: string | undefined): Promise<Record<string, unknown>> => {
    if (userUrl === undefined)
      throw new Error(`kayjs-auth: the ${provider.name} provider has neither a userUrl nor an ID token to read the user from`)

    const { res, text } = await askProvider(provider.name, 'user fetch', userUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...provider.authHeaders?.(accessToken),
      },
    })

    if (!res.ok)
      throw new OAuthExchangeError(res.status, `OAuth user fetch failed (${provider.name}): ${res.status} ${redactBody(text)}`)

    return parseJson(provider.name, 'user fetch', text) as Record<string, unknown>
  }

  const checkIdToken = async (idToken: string | undefined, check: OpenIdCheck, nonce: string | undefined): Promise<Record<string, unknown>> => {
    if (idToken === undefined)
      throw new OAuthExchangeError(400, `OAuth token response missing id_token (${provider.name})`)

    // jose loads with the first ID token, so an app with no OpenID provider never reads it.
    const { createRemoteJWKSet, errors, jwtVerify } = await import('jose')
    let keys = keySets.get(check.jwksUrl)

    if (!keys) {
      keys = createRemoteJWKSet(new URL(check.jwksUrl))
      keySets.set(check.jwksUrl, keys)
    }

    let claims: Record<string, unknown>

    try {
      ({ payload: claims } = await jwtVerify(idToken, keys, { ...typeof check.issuer === 'function' ? {} : { issuer: check.issuer }, audience: config.clientId, algorithms: check.algorithms ?? ID_TOKEN_ALGORITHMS, clockTolerance: CLOCK_TOLERANCE_S, requiredClaims: ['sub', 'iat', 'exp'] }))
    }
    catch (error) {
      // A key set out of reach is the provider down; any other failure, a token not to trust.
      const refused = error instanceof errors.JOSEError && error.code !== 'ERR_JOSE_GENERIC' && !(error instanceof errors.JWKSTimeout)

      throw new OAuthExchangeError(refused ? 400 : 502, `OAuth ID token refused (${provider.name}): ${error instanceof Error ? error.message : String(error)}`)
    }

    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]

    if (typeof check.issuer === 'function' && !check.issuer(claims))
      throw new OAuthExchangeError(400, `OAuth ID token refused (${provider.name}): unexpected issuer`)

    // A token for several clients names the one it was given to.
    if (audiences.length > 1 && claims.azp !== config.clientId)
      throw new OAuthExchangeError(400, `OAuth ID token refused (${provider.name}): issued to another client`)

    if (nonce !== undefined && claims.nonce !== nonce)
      throw new OAuthExchangeError(400, `OAuth ID token refused (${provider.name}): nonce mismatch`)

    return claims
  }

  return {
    /** The provider authorize URL to redirect the user to. */
    async authorizeUrl({ state, codeChallenge, nonce, extraParams }: AuthorizeUrlOptions = {}): Promise<string> {
      const { openId } = await endpoints()
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: 'code',
        scope: provider.scopes.join(provider.scopeSeparator ?? ' '),
        ...provider.authorizeParams,
        ...extraParams,
      })

      if (state !== undefined)
        params.set('state', state)

      if (codeChallenge !== undefined) {
        params.set('code_challenge', codeChallenge)
        params.set('code_challenge_method', 'S256')
      }

      if (nonce !== undefined && openId)
        params.set('nonce', nonce)

      return `${await endpoint('authorizeUrl')}?${params}`
    },

    /** Exchanges an authorization code for tokens (replay the PKCE `codeVerifier` if used). */
    async exchangeCode(code: string, opts: { codeVerifier?: string } = {}): Promise<OAuthTokens> {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.redirectUri,
      })

      if (opts.codeVerifier !== undefined)
        body.set('code_verifier', opts.codeVerifier)

      return tokensFrom(provider, await postToken(provider.name, provider.tokenAccept, await endpoint('tokenUrl'), await withCredentials(body)))
    },

    /** Refreshes tokens with a refresh token. */
    async refreshTokens(refreshToken: string): Promise<OAuthTokens> {
      return tokensFrom(provider, await postToken(provider.name, provider.tokenAccept, await endpoint('tokenUrl'), await withCredentials(new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }))))
    },

    /** Fetches and normalizes the provider user. */
    async fetchUser(accessToken: string): Promise<User> {
      return provider.normalizeUser(await userInfo(accessToken, (await endpoints()).userUrl) as Raw, {})
    },

    /** The user a sign-in came back with: for OpenID Connect, off the ID token once checked, the user endpoint's answer over it when there is one; `callback` holds the parameters the provider came back with. */
    async readUser(tokens: OAuthTokens, opts: { nonce?: string | undefined, callback?: Record<string, string> } = {}): Promise<User> {
      const { userUrl, openId } = await endpoints()
      const callback = opts.callback ?? {}

      if (!openId)
        return provider.normalizeUser(await userInfo(tokens.accessToken, userUrl) as Raw, callback)

      const claims = await checkIdToken(tokens.idToken, openId, opts.nonce)

      if (userUrl === undefined)
        return provider.normalizeUser(claims as Raw, callback)

      const info = await userInfo(tokens.accessToken, userUrl)

      // An answer about another account than the token's would put one user's details on another.
      if (info.sub !== claims.sub)
        throw new OAuthExchangeError(502, `OAuth user fetch failed (${provider.name}): the user endpoint answered for another subject`)

      return provider.normalizeUser({ ...claims, ...info } as Raw, callback)
    },
  }
}

// The provider's answer read whole: one that hangs past the timeout, or a dropped connection, is the provider down.
async function askProvider(name: string, what: string, url: string, init: RequestInit): Promise<{ res: Response, text: string }> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) })

    return { res, text: await res.text() }
  }
  catch (error) {
    throw new OAuthExchangeError(502, `OAuth ${what} failed (${name}): ${error instanceof Error ? error.message : String(error)}`)
  }
}

// The body stays out of the error: a successful answer may hold tokens.
function parseJson(name: string, what: string, text: string): unknown {
  try {
    return JSON.parse(text)
  }
  catch {
    throw new OAuthExchangeError(502, `OAuth ${what} failed (${name}): the answer is not JSON`)
  }
}

// A token answer the provider's parser cannot read, an app's own provider included, is the provider misbehaving rather than a server error.
function tokensFrom<Raw, User>(provider: OAuthProvider<Raw, User>, raw: unknown): OAuthTokens {
  try {
    return provider.parseTokens(raw)
  }
  catch (error) {
    if (error instanceof OAuthExchangeError)
      throw error

    throw new OAuthExchangeError(502, `OAuth token request failed (${provider.name}): ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function postToken(name: string, accept: OAuthProvider['tokenAccept'], tokenUrl: string, body: URLSearchParams): Promise<unknown> {
  const { res, text } = await askProvider(name, 'token request', tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body,
  })

  if (!res.ok)
    throw new OAuthExchangeError(res.status, `OAuth token request failed (${name}): ${res.status} ${redactBody(text)}`)

  const isJson = accept === 'json'
    || (accept !== 'form' && (res.headers.get('content-type') ?? '').includes('json'))

  const parsed = (isJson ? parseJson(name, 'token request', text) : Object.fromEntries(new URLSearchParams(text))) as { error?: unknown } | null

  // GitHub answers a refused grant with a 200 carrying `error`, where the spec answers a 400.
  if (typeof parsed?.error === 'string')
    throw new OAuthExchangeError(400, `OAuth token request refused (${name}): ${parsed.error}`)

  return parsed
}
