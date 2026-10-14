import type { OAuthProvider, OAuthTokens, OAuthUser } from './types'
import { importPKCS8, SignJWT } from 'jose'
import { PROVIDER_TIMEOUT_MS } from './timeout'

const TRAILING_SLASHES = /\/+$/
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
  return hash ? `https://cdn.discordapp.com/${kind}/${userId}/${hash}.${hash.startsWith('a_') ? 'gif' : 'png'}` : null
}

/** Discord OAuth2 provider preset, its avatar and banner as CDN URLs. */
export function discordProvider(opts: { scopes?: string[], apiBase?: string } = {}): OAuthProvider<DiscordRawUser> {
  const apiBase = opts.apiBase ?? 'https://discord.com/api/v10'

  return {
    name: 'discord',
    label: 'Discord',
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: `${apiBase}/oauth2/token`,
    userUrl: `${apiBase}/users/@me`,
    scopes: opts.scopes ?? ['identify', 'email'],
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

/** GitHub OAuth provider preset. Classic OAuth-App tokens do not expire, so `expiresAt` stays undefined. */
export function githubProvider(opts: { scopes?: string[] } = {}): OAuthProvider<GithubRawUser> {
  return {
    name: 'github',
    label: 'GitHub',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userUrl: 'https://api.github.com/user',
    scopes: opts.scopes ?? ['read:user'],
    authHeaders: () => ({
      'User-Agent': '@kaynooo/kayjs-auth',
      'Accept': 'application/vnd.github+json',
    }),
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
  /** The `alg` values the provider signs ID tokens with, when not `RS256`, `PS256`, `ES256` or `EdDSA`, as `['RS384']`. */
  algorithms?: string[]
  params?: Record<string, string>
}

const OPENID_SCOPES = ['openid', 'email', 'profile']

// Anything but https is refused in production, where a plain-http endpoint lets whoever sits on the path read the codes and tokens or answer in the provider's place.
function requireHttps(url: string, what: string): void {
  if (process.env.NODE_ENV === 'production' && new URL(url).protocol !== 'https:')
    throw new Error(`${what} ${url} is not https, which production refuses`)
}

const idTokenAlgorithms = (opts: OpenIdOptions) => opts.algorithms === undefined ? {} : { algorithms: opts.algorithms }

/** Any OpenID Connect provider by its issuer URL, its endpoints read off its discovery document on first use: Keycloak, Authentik, Auth0, Okta, Zitadel... */
export function oidcProvider(opts: OpenIdOptions & { issuer: string, name?: string }): OAuthProvider<OpenIdClaims> {
  const issuer = opts.issuer.replace(TRAILING_SLASHES, '')

  requireHttps(issuer, 'the OpenID Connect issuer')

  return {
    name: opts.name ?? new URL(issuer).host,
    scopes: opts.scopes ?? OPENID_SCOPES,
    ...opts.params === undefined ? {} : { authorizeParams: opts.params },
    discover: async () => {
      const res = await fetch(`${issuer}/.well-known/openid-configuration`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) })

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
        openId: { issuer: doc.issuer, jwksUrl: doc.jwks_uri as string, ...idTokenAlgorithms(opts) },
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
    openId: { issuer: ['https://accounts.google.com', 'accounts.google.com'], jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs', ...idTokenAlgorithms(opts) },
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
    openId: { issuer: claims => microsoftIssued(tenant, claims), jwksUrl: `${base}/discovery/v2.0/keys`, ...idTokenAlgorithms(opts) },
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

  if (tenant === 'organizations')
    return tid !== MICROSOFT_PERSONAL_TENANT

  return tid === tenant
}

/** GitLab sign-in, on gitlab.com or a self-hosted instance at `url`. */
export function gitlabProvider(opts: OpenIdOptions & { url?: string } = {}): OAuthProvider<OpenIdClaims> {
  const base = (opts.url ?? 'https://gitlab.com').replace(TRAILING_SLASHES, '')

  requireHttps(base, 'the GitLab url')

  return {
    name: 'gitlab',
    label: 'GitLab',
    authorizeUrl: `${base}/oauth/authorize`,
    tokenUrl: `${base}/oauth/token`,
    userUrl: `${base}/oauth/userinfo`,
    openId: { issuer: base, jwksUrl: `${base}/oauth/discovery/keys`, ...idTokenAlgorithms(opts) },
    scopes: opts.scopes ?? OPENID_SCOPES,
    ...opts.params === undefined ? {} : { authorizeParams: opts.params },
    parseTokens: parseStandardTokens,
    normalizeUser: openIdUser,
  }
}

/** Sign in with Apple. Its client secret is a JWT signed with the app's key from the Apple developer account: `teamId`, the key's `keyId`, and `privateKey`, the `.p8` file's PEM text. The app's `clientId` is its Services ID, and it needs no `clientSecret`. */
export function appleProvider(opts: { teamId: string, keyId: string, privateKey: string, scopes?: string[] }): OAuthProvider<OpenIdClaims> {
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
    authorizeParams: { response_mode: 'form_post' },
    async clientSecret(clientId) {
      if (signed?.clientId === clientId && signed.expires - Date.now() > APPLE_SECRET_MARGIN_MS)
        return signed.value

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
function parseStandardTokens(raw: any): OAuthTokens {
  if (!raw?.access_token)
    throw new Error(`OAuth token response missing access_token${raw?.error ? `: ${raw.error}` : ''}`)

  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? undefined,
    expiresAt: typeof raw.expires_in === 'number' ? Date.now() + raw.expires_in * 1000 : undefined,
    scope: raw.scope ?? undefined,
    tokenType: raw.token_type ?? undefined,
    idToken: typeof raw.id_token === 'string' ? raw.id_token : undefined,
  }
}
