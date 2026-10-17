import type { OAuthProvider, OAuthTokens, OAuthUser } from './types'
import { log } from '../log'
import { PROVIDER_TIMEOUT_MS } from './timeout'

const TRAILING_SLASHES = /\/+$/
const SCOPE_SEPARATORS = /[\s,]+/

/** What every provider preset takes: other `scopes` than its own, extra authorize URL `params` such as `{ prompt: 'consent' }`, and for one a server can host (GitHub Enterprise, GitLab, Discord's API), its base `url`, any trailing slash dropped and any path kept. */
export interface ProviderOptions {
  scopes?: string[]
  params?: Record<string, string>
  url?: string
}
// The tenant Microsoft signs personal accounts in under, whatever the app's.
const MICROSOFT_PERSONAL_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad'
const APPLE_SECRET_LIFETIME_S = 24 * 60 * 60
// A cached Apple client secret is signed again this long before it ends.
const APPLE_SECRET_MARGIN_MS = 60 * 60 * 1000

interface DiscordRawUser {
  id: string
  username: string
  global_name?: string | null
  avatar?: string | null
  banner?: string | null
  email?: string | null
  // Whether Discord checked `email`.
  verified?: boolean
}

// Discord answers bare image hashes; a hash starting `a_` is animated, served as a gif.
function discordImage(kind: 'avatars' | 'banners', userId: string, hash: string | null | undefined): string | null {
  return hash == null || hash === '' ? null : `https://cdn.discordapp.com/${kind}/${userId}/${hash}.${hash.startsWith('a_') ? 'gif' : 'png'}`
}

let warnedApiBase = false

/** Discord OAuth2 provider preset, its avatar and banner as CDN URLs. `url` is the API's base, `https://discord.com/api/v10` by default, and `params` extra authorize URL parameters. */
export function discordProvider(opts: ProviderOptions & {
  /** @deprecated Renamed `url`, as on every provider. */
  apiBase?: string
} = {}): OAuthProvider<DiscordRawUser> {
  if (opts.apiBase !== undefined && opts.url === undefined && !warnedApiBase) {
    warnedApiBase = true
    log.warn('discordProvider({ apiBase }) is renamed discordProvider({ url })')
  }

  const apiBase = providerUrl(opts.url ?? opts.apiBase, 'https://discord.com/api/v10', 'the Discord url')

  return {
    name: 'discord',
    label: 'Discord',
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: `${apiBase}/oauth2/token`,
    userUrl: `${apiBase}/users/@me`,
    scopes: opts.scopes ?? ['identify', 'email'],
    ...opts.params === undefined ? {} : { authorizeParams: opts.params },
    parseTokens: parseStandardTokens,
    normalizeUser: raw => ({
      providerId: raw.id,
      username: raw.username,
      displayName: raw.global_name ?? undefined,
      avatar: discordImage('avatars', raw.id, raw.avatar),
      banner: discordImage('banners', raw.id, raw.banner),
      email: raw.verified === true ? raw.email ?? null : null,
    }),
  }
}

interface GithubRawUser {
  id: number
  login: string
  name?: string | null
  avatar_url?: string | null
  email?: string | null
}

// GitHub's `/user/emails` list: the primary address is the one the account is known by.
interface GithubEmail {
  email?: unknown
  primary?: unknown
  verified?: unknown
}

/** GitHub OAuth provider preset. Classic OAuth-App tokens do not expire, so `expiresAt` stays undefined. With the `user:email` scope the email is the account's primary verified address read off `/user/emails`, so a user hiding their email on their profile signs in with it all the same; without it, the public one. `url` is a GitHub Enterprise Server's base, as `https://git.example.com`. */
export function githubProvider(opts: ProviderOptions = {}): OAuthProvider<GithubRawUser> {
  const base = opts.url === undefined ? undefined : providerUrl(opts.url, '', 'the GitHub url')
  const api = base === undefined ? 'https://api.github.com' : `${base}/api/v3`
  const scopes = opts.scopes ?? ['read:user']
  const headers = {
    'User-Agent': '@kaynooo/kayjs-auth',
    'Accept': 'application/vnd.github+json',
  }

  return {
    name: 'github',
    label: 'GitHub',
    authorizeUrl: `${base ?? 'https://github.com'}/login/oauth/authorize`,
    tokenUrl: `${base ?? 'https://github.com'}/login/oauth/access_token`,
    userUrl: `${api}/user`,
    scopes,
    ...opts.params === undefined ? {} : { authorizeParams: opts.params },
    authHeaders: () => headers,
    async completeUser(raw, { accessToken, scope }) {
      // What the token was granted when GitHub said, else what was asked for.
      const granted = new Set((scope ?? scopes.join(' ')).split(SCOPE_SEPARATORS))

      if (!granted.has('user:email') && !granted.has('user'))
        return raw

      try {
        const res = await fetch(`${api}/user/emails`, { headers: { ...headers, Authorization: `Bearer ${accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) })

        if (!res.ok)
          throw new Error(`answered ${res.status}`)

        const list = await res.json() as unknown
        const primary = Array.isArray(list) ? (list as GithubEmail[]).find(entry => entry?.primary === true && entry.verified === true && typeof entry.email === 'string' && entry.email !== '') : undefined

        return { ...raw, email: primary === undefined ? raw.email ?? null : primary.email as string }
      }
      catch (error) {
        log.warn(`GitHub's /user/emails could not be read, the sign-in goes on with the profile's email: ${error instanceof Error ? error.message : String(error)}`)

        return raw
      }
    },
    parseTokens: parseStandardTokens,
    normalizeUser: raw => ({
      // Not `String(raw.id)`, which makes a missing id the string "undefined".
      providerId: typeof raw.id === 'number' ? String(raw.id) : '',
      username: raw.login,
      displayName: raw.name ?? undefined,
      avatar: raw.avatar_url ?? null,
      email: raw.email ?? null,
    }),
  }
}

/** The standard OpenID Connect claims the presets read, off the ID token and the user endpoint. */
export interface OpenIdClaims {
  sub: string
  email?: string
  // Apple sends it as the string 'true'.
  email_verified?: boolean | string
  name?: string
  preferred_username?: string
  nickname?: string
  picture?: string
}

/** Options every OpenID Connect preset takes: other scopes than its own, and extra authorize URL parameters, such as Google's `{ access_type: 'offline', prompt: 'consent' }` for a refresh token. */
export interface OpenIdOptions {
  scopes?: string[]
  /** The `alg` values the provider signs ID tokens with, to narrow the asymmetric ones accepted by default (`RS*`, `PS*`, `ES*`, `EdDSA`), as `['RS256']`. */
  algorithms?: string[]
  params?: Record<string, string>
}

const OPENID_SCOPES = ['openid', 'email', 'profile']

// Anything but https is refused in production, where a plain-http endpoint lets whoever sits on the path read the codes and tokens or answer in the provider's place.
function requireHttps(url: string, what: string): void {
  if (process.env.NODE_ENV === 'production' && new URL(url).protocol !== 'https:')
    throw new Error(`${what} ${url} is not https, which production refuses`)
}

// A provider's base URL without its trailing slashes, `fallback` when the app gave none.
function providerUrl(url: string | undefined, fallback: string, what: string): string {
  const base = (url ?? fallback).replace(TRAILING_SLASHES, '')

  if (base !== '')
    requireHttps(base, what)

  return base
}

/** Any OpenID Connect provider by its issuer URL, its endpoints read off its discovery document on first use: Keycloak, Authentik, Auth0, Okta, Zitadel... */
export function oidcProvider(opts: OpenIdOptions & { issuer: string, name?: string }): OAuthProvider<OpenIdClaims> {
  const issuer = opts.issuer.replace(TRAILING_SLASHES, '')

  requireHttps(issuer, 'the OpenID Connect issuer')

  return {
    name: opts.name ?? new URL(issuer).host,
    scopes: opts.scopes ?? OPENID_SCOPES,
    ...opts.params === undefined ? {} : { authorizeParams: opts.params },
    discover: async () => {
      const res = await fetch(`${issuer}/.well-known/openid-configuration`, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) })

      if (!res.ok)
        throw new Error(`discovery document answered ${res.status}`)

      const doc = await res.json() as Record<string, unknown>

      // A document naming another issuer would let that issuer's tokens through.
      if (typeof doc.issuer !== 'string' || doc.issuer.replace(TRAILING_SLASHES, '') !== issuer)
        throw new Error(`discovery document names the issuer ${String(doc.issuer)}, not ${issuer}`)

      for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
        if (typeof doc[field] !== 'string')
          throw new Error(`discovery document has no ${field}`)
      }

      for (const field of ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint', 'jwks_uri']) {
        if (typeof doc[field] === 'string')
          requireHttps(doc[field], `the discovery document's ${field}`)
      }

      return {
        authorizeUrl: doc.authorization_endpoint as string,
        tokenUrl: doc.token_endpoint as string,
        userUrl: typeof doc.userinfo_endpoint === 'string' ? doc.userinfo_endpoint : undefined,
        openId: { issuer: doc.issuer, jwksUrl: doc.jwks_uri as string, algorithms: opts.algorithms },
      }
    },
    parseTokens: parseStandardTokens,
    normalizeUser: openIdUser,
  }
}

/** Google sign-in. */
export function googleProvider(opts: OpenIdOptions = {}): OAuthProvider<OpenIdClaims> {
  return {
    name: 'google',
    label: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    openId: { issuer: ['https://accounts.google.com', 'accounts.google.com'], jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs', algorithms: opts.algorithms },
    scopes: opts.scopes ?? OPENID_SCOPES,
    ...opts.params === undefined ? {} : { authorizeParams: opts.params },
    parseTokens: parseStandardTokens,
    // Google has no usernames.
    normalizeUser: claims => ({ ...openIdUser(claims), username: '' }),
  }
}

/** Microsoft sign-in. `tenant` is `common` (personal and work accounts, the default), `consumers` (personal only), `organizations` (work only) or one organization's tenant id. */
export function microsoftProvider(opts: OpenIdOptions & { tenant?: string } = {}): OAuthProvider<OpenIdClaims & { tid?: string, xms_edov?: boolean | string | number }> {
  const tenant = opts.tenant ?? 'common'
  const base = `https://login.microsoftonline.com/${tenant}`

  return {
    name: 'microsoft',
    label: 'Microsoft',
    authorizeUrl: `${base}/oauth2/v2.0/authorize`,
    tokenUrl: `${base}/oauth2/v2.0/token`,
    // The issuer names the account's own tenant, so a multi-tenant app checks it against the token's `tid`.
    openId: { issuer: claims => microsoftIssued(tenant, claims), jwksUrl: `${base}/discovery/v2.0/keys`, algorithms: opts.algorithms },
    scopes: opts.scopes ?? OPENID_SCOPES,
    ...opts.params === undefined ? {} : { authorizeParams: opts.params },
    parseTokens: parseStandardTokens,
    normalizeUser: (claims) => {
      // A work account's `email` is whatever its organization typed, verified only when the `xms_edov` optional claim says the domain's owner vouches for it.
      const verified = claims.tid === MICROSOFT_PERSONAL_TENANT || claims.xms_edov === true || claims.xms_edov === '1' || claims.xms_edov === 1

      // `preferred_username` is a sign-in address, not a name.
      return { ...openIdUser(claims), username: '', email: verified ? claims.email ?? null : null }
    },
  }
}

function microsoftIssued(tenant: string, claims: Record<string, unknown>): boolean {
  const tid = claims.tid

  if (typeof tid !== 'string' || claims.iss !== `https://login.microsoftonline.com/${tid}/v2.0`)
    return false

  if (tenant === 'common')
    return true

  if (tenant === 'consumers')
    return tid === MICROSOFT_PERSONAL_TENANT

  return tenant === 'organizations' ? tid !== MICROSOFT_PERSONAL_TENANT : tid === tenant
}

/** GitLab sign-in, on gitlab.com or a self-hosted instance at `url`. */
export function gitlabProvider(opts: OpenIdOptions & { url?: string } = {}): OAuthProvider<OpenIdClaims> {
  const base = providerUrl(opts.url, 'https://gitlab.com', 'the GitLab url')

  return {
    name: 'gitlab',
    label: 'GitLab',
    authorizeUrl: `${base}/oauth/authorize`,
    tokenUrl: `${base}/oauth/token`,
    userUrl: `${base}/oauth/userinfo`,
    openId: { issuer: base, jwksUrl: `${base}/oauth/discovery/keys`, algorithms: opts.algorithms },
    scopes: opts.scopes ?? OPENID_SCOPES,
    ...opts.params === undefined ? {} : { authorizeParams: opts.params },
    parseTokens: parseStandardTokens,
    normalizeUser: openIdUser,
  }
}

/** Sign in with Apple. Its client secret is a JWT signed with the app's key from the Apple developer account: `teamId`, the key's `keyId`, and `privateKey`, the `.p8` file's PEM text. The app's `clientId` is its Services ID, and it needs no `clientSecret`. */
export function appleProvider(opts: Pick<ProviderOptions, 'scopes' | 'params'> & { teamId: string, keyId: string, privateKey: string }): OAuthProvider<OpenIdClaims> {
  let key: Promise<CryptoKey> | undefined
  let signed: { clientId: string, value: string, expires: number } | undefined

  return {
    name: 'apple',
    label: 'Apple',
    authorizeUrl: 'https://appleid.apple.com/auth/authorize',
    tokenUrl: 'https://appleid.apple.com/auth/token',
    openId: { issuer: 'https://appleid.apple.com', jwksUrl: 'https://appleid.apple.com/auth/keys' },
    scopes: opts.scopes ?? ['name', 'email'],
    // Apple answers a request for the name or the email only through a POST back to the callback.
    authorizeParams: { ...opts.params, response_mode: 'form_post' },
    async clientSecret(clientId) {
      if (signed?.clientId === clientId && signed.expires - Date.now() > APPLE_SECRET_MARGIN_MS)
        return signed.value

      // jose loads when Apple's secret is first signed.
      const { importPKCS8, SignJWT } = await import('jose')

      key ??= importPKCS8(opts.privateKey, 'ES256')

      const now = Math.floor(Date.now() / 1000)
      const value = await new SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: opts.keyId })
        .setIssuer(opts.teamId)
        .setSubject(clientId)
        .setAudience('https://appleid.apple.com')
        .setIssuedAt(now)
        .setExpirationTime(now + APPLE_SECRET_LIFETIME_S)
        .sign(await key)

      signed = { clientId, value, expires: (now + APPLE_SECRET_LIFETIME_S) * 1000 }

      return value
    },
    parseTokens: parseStandardTokens,
    // Apple has no usernames, and names the user only on their first sign-in, in the callback's `user` rather than the token.
    normalizeUser: (claims, callback) => ({ ...openIdUser(claims), username: '', displayName: appleName(callback?.user) }),
  }
}

function appleName(user: string | undefined): string | undefined {
  try {
    const name = (JSON.parse(user ?? '{}') as { name?: { firstName?: unknown, lastName?: unknown } }).name
    const parts = [name?.firstName, name?.lastName].filter(part => typeof part === 'string' && part.trim() !== '')

    return parts.length > 0 ? parts.join(' ') : undefined
  }
  catch {
    return undefined
  }
}

function openIdUser(claims: OpenIdClaims): OAuthUser {
  return {
    providerId: typeof claims.sub === 'string' ? claims.sub : '',
    username: claims.preferred_username ?? claims.nickname ?? '',
    displayName: claims.name ?? undefined,
    avatar: claims.picture ?? null,
    email: claims.email_verified === true || claims.email_verified === 'true' ? claims.email ?? null : null,
  }
}

/** Maps a standard OAuth2 token payload (`access_token`, `expires_in`, ...) to `OAuthTokens`. */
function parseStandardTokens(raw: unknown): OAuthTokens {
  const answer = (raw ?? {}) as { access_token?: unknown, refresh_token?: string | null, expires_in?: unknown, scope?: string | null, token_type?: string | null, id_token?: unknown, error?: string | null }

  if (typeof answer.access_token !== 'string' || answer.access_token === '')
    throw new Error(`OAuth token response missing access_token${answer.error == null || answer.error === '' ? '' : `: ${answer.error}`}`)

  return {
    accessToken: answer.access_token,
    refreshToken: answer.refresh_token ?? undefined,
    expiresAt: typeof answer.expires_in === 'number' ? Date.now() + answer.expires_in * 1000 : undefined,
    scope: answer.scope ?? undefined,
    tokenType: answer.token_type ?? undefined,
    idToken: typeof answer.id_token === 'string' ? answer.id_token : undefined,
  }
}
