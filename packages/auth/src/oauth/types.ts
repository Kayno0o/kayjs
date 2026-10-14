/** Normalized OAuth credentials. `expiresAt` is absolute ms; `undefined` = non-expiring (e.g. GitHub classic tokens). */
export interface OAuthTokens {
  accessToken: string
  refreshToken?: string | undefined
  expiresAt?: number | undefined
  scope?: string | undefined
  tokenType?: string | undefined
  /** The OpenID Connect ID token, checked before anything is read from it. */
  idToken?: string | undefined
}

/** The normalized provider identity both presets map onto. */
export interface OAuthUser {
  providerId: string
  username: string
  displayName?: string | undefined
  avatar?: string | null | undefined
  /** The wide image atop the provider's profile, as a URL, for a provider that has one. */
  banner?: string | null | undefined
  email?: string | null | undefined
}

/** How an OpenID Connect provider's ID token is checked: signed by a key of `jwksUrl`, by `issuer`, for this client, unexpired, carrying the flow's nonce. */
export interface OpenIdCheck {
  /** The expected `iss`, or a test of the claims for a provider whose issuer names the tenant, as Microsoft's does. */
  issuer: string | string[] | ((claims: Record<string, unknown>) => boolean)
  jwksUrl: string
  /** The `alg` header values an ID token may carry, `RS256`, `PS256`, `ES256` and `EdDSA` when left out; a token signed otherwise, with `none` or with a shared-secret `HS*` included, is refused. */
  algorithms?: string[] | undefined
}

/** Where a provider is reached; an OpenID Connect one with `openId` reads its user off the ID token, and off `userUrl` too when it has one. */
export interface OAuthEndpoints {
  authorizeUrl?: string | undefined
  tokenUrl?: string | undefined
  userUrl?: string | undefined
  openId?: OpenIdCheck | undefined
}

/** A provider's OAuth endpoints plus how to parse its token/user responses. */
export interface OAuthProvider<Raw = any, User = OAuthUser> extends OAuthEndpoints {
  name: string
  /** The provider's name as a sign-in button shows it, `GitHub`; `name` without it. */
  label?: string
  /** Endpoints read from the provider on first use, such as an OpenID Connect discovery document, over the ones set here. */
  discover?: () => Promise<OAuthEndpoints>
  scopes: string[]
  /** Extra authorize URL parameters, such as Apple's `response_mode=form_post` or Google's `access_type=offline`. */
  authorizeParams?: Record<string, string>
  /** A client secret made per request, such as Apple's signed JWT, over the app's `clientSecret`. */
  clientSecret?: (clientId: string) => Promise<string>
  /** How scopes are joined in the authorize URL (default `' '`). */
  scopeSeparator?: string
  /** Forces token-response parsing; when unset the response `content-type` decides. */
  tokenAccept?: 'json' | 'form'
  /** Extra headers for the user-info request (e.g. GitHub's `User-Agent`/`Accept`). */
  authHeaders?: (accessToken: string) => Record<string, string>
  parseTokens: (raw: any) => OAuthTokens
  /** `raw` is the user endpoint's answer or, for OpenID Connect, the ID token's claims with the user endpoint's over them; `callback` the parameters the provider came back with. */
  normalizeUser: (raw: Raw, callback?: Record<string, string>) => User
}

/** The consumer's OAuth app credentials; no `clientSecret` for a public client, or a provider making its own. */
export interface OAuthClientConfig {
  clientId: string
  clientSecret?: string | undefined
  redirectUri: string
}
