import type { OAuthProvider, OAuthTokens } from './types'

interface DiscordRawUser {
  id: string
  username: string
  global_name?: string | null
  avatar?: string | null
  email?: string | null
  // Whether Discord checked `email`.
  verified?: boolean
}

/** Discord OAuth2 provider preset. */
export function discordProvider(opts: { scopes?: string[], apiBase?: string } = {}): OAuthProvider<DiscordRawUser> {
  const apiBase = opts.apiBase ?? 'https://discord.com/api/v10'

  return {
    name: 'discord',
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: `${apiBase}/oauth2/token`,
    userUrl: `${apiBase}/users/@me`,
    scopes: opts.scopes ?? ['identify', 'email'],
    parseTokens: parseStandardTokens,
    normalizeUser: raw => ({
      providerId: raw.id,
      username: raw.username,
      displayName: raw.global_name ?? undefined,
      avatar: raw.avatar ?? null,
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
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userUrl: 'https://api.github.com/user',
    scopes: opts.scopes ?? ['read:user'],
    authHeaders: () => ({
      'User-Agent': '@kaynooo/kay-auth',
      'Accept': 'application/vnd.github+json',
    }),
    parseTokens: parseStandardTokens,
    normalizeUser: raw => ({
      providerId: String(raw.id),
      username: raw.login,
      displayName: raw.name ?? undefined,
      avatar: raw.avatar_url ?? null,
      email: raw.email ?? null,
    }),
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
  }
}
