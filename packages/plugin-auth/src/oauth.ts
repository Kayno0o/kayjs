// Zero-dependency OAuth 2.0 + PKCE (S256) provider definitions for @kayjs/auth.

export const OAUTH_FETCH_TIMEOUT_MS = 10_000

export interface OAuthProfile {
  id: string
  email: string
  emailVerified: boolean
  name?: string | undefined
  avatarUrl?: string | undefined
}

export interface OAuthProvider {
  id: string
  clientId: string
  clientSecret: string
  authorizeUrl: string
  tokenUrl: string
  scopes: string[]
  pkce?: boolean | undefined
  fetchProfile: (accessToken: string) => Promise<OAuthProfile>
}

export interface OAuthPresetConfig {
  clientId: string
  clientSecret: string
  scopes?: string[] | undefined
}

export function oauthProvider(def: OAuthProvider): OAuthProvider {
  return def
}

interface GitHubEmail {
  email: string
  primary: boolean
  verified: boolean
}

export function github(config: OAuthPresetConfig): OAuthProvider {
  return {
    id: 'github',
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: config.scopes ?? ['read:user', 'user:email'],
    pkce: false,
    async fetchProfile(accessToken) {
      const headers = { 'authorization': `Bearer ${accessToken}`, 'accept': 'application/vnd.github+json', 'user-agent': 'kayjs-auth' }
      const userRes = await fetch('https://api.github.com/user', {
        headers,
        signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
      })
      if (!userRes.ok)
        throw new Error(`github profile fetch failed: ${userRes.status}`)
      const user = await userRes.json() as { id: number, email?: string | null, name?: string | null, login?: string, avatar_url?: string }
      let email = user.email ?? ''
      let emailVerified = false

      // Always query /user/emails: /user does not indicate whether a public email is verified.
      const emailRes = await fetch('https://api.github.com/user/emails', {
        headers,
        signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
      })
      if (emailRes.ok) {
        const raw = await emailRes.json() as unknown
        const emails = Array.isArray(raw) ? raw as GitHubEmail[] : []
        const matched = email ? emails.find(e => e.email.toLowerCase() === email.toLowerCase()) : undefined
        if (matched?.verified) {
          email = matched.email
          emailVerified = true
        }
        else {
          const best = emails.find(e => e.primary && e.verified) ?? emails.find(e => e.verified) ?? matched ?? emails[0]
          if (best) {
            email = best.email
            emailVerified = Boolean(best.verified)
          }
        }
      }

      if (!email)
        throw new Error('github profile did not return an email address')
      return {
        id: String(user.id),
        email,
        emailVerified,
        name: user.name ?? user.login,
        avatarUrl: user.avatar_url,
      }
    },
  }
}

export function discord(config: OAuthPresetConfig): OAuthProvider {
  return {
    id: 'discord',
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    scopes: config.scopes ?? ['identify', 'email'],
    pkce: true,
    async fetchProfile(accessToken) {
      const res = await fetch('https://discord.com/api/users/@me', {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
      })
      if (!res.ok)
        throw new Error(`discord profile fetch failed: ${res.status}`)
      const u = await res.json() as { id: string, email?: string, verified?: boolean, global_name?: string, username: string, avatar?: string | null }
      if (!u.email)
        throw new Error('discord profile did not return an email address')
      const avatarUrl = u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png` : undefined
      return {
        id: u.id,
        email: u.email,
        emailVerified: Boolean(u.verified),
        name: u.global_name ?? u.username,
        avatarUrl,
      }
    },
  }
}

export function google(config: OAuthPresetConfig): OAuthProvider {
  return {
    id: 'google',
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: config.scopes ?? ['openid', 'email', 'profile'],
    pkce: true,
    async fetchProfile(accessToken) {
      const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
      })
      if (!res.ok)
        throw new Error(`google profile fetch failed: ${res.status}`)
      const u = await res.json() as { sub: string, email?: string, email_verified?: boolean, name?: string, picture?: string }
      if (!u.email)
        throw new Error('google profile did not return an email address')
      return {
        id: u.sub,
        email: u.email,
        emailVerified: Boolean(u.email_verified),
        name: u.name,
        avatarUrl: u.picture,
      }
    },
  }
}
