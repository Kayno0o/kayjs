/** Normalized OAuth credentials. `expiresAt` is absolute ms; `undefined` = non-expiring (e.g. GitHub classic tokens). */
export interface OAuthTokens {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  scope?: string
  tokenType?: string
}

/** The normalized provider identity both presets map onto. */
export interface OAuthUser {
  providerId: string
  username: string
  displayName?: string
  avatar?: string | null
  email?: string | null
}

/** A provider's OAuth endpoints plus how to parse its token/user responses. */
export interface OAuthProvider<Raw = any, User = OAuthUser> {
  name: string
  authorizeUrl: string
  tokenUrl: string
  userUrl: string
  scopes: string[]
  /** How scopes are joined in the authorize URL (default `' '`). */
  scopeSeparator?: string
  /** Forces token-response parsing; when unset the response `content-type` decides. */
  tokenAccept?: 'json' | 'form'
  /** Extra headers for the user-info request (e.g. GitHub's `User-Agent`/`Accept`). */
  authHeaders?: (accessToken: string) => Record<string, string>
  parseTokens: (raw: any) => OAuthTokens
  normalizeUser: (raw: Raw) => User
}

/** The consumer's OAuth app credentials. */
export interface OAuthClientConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
}
