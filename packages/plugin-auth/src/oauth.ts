// Zero-dependency OAuth 2.0 + PKCE (S256) provider definitions for @kayjs/auth.

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
      const userRes = await fetch('https://api.github.com/user', { headers })
      if (!userRes.ok)
        throw new Error(`github profile fetch failed: ${userRes.status}`)
      const user = await userRes.json() as { id: number, email?: string | null, name?: string | null, login?: string, avatar_url?: string }
      let email = user.email ?? ''
      let emailVerified = false
      if (!email) {
        const emailRes = await fetch('https://api.github.com/user/emails', { headers })
        if (emailRes.ok) {
          const emails = await emailRes.json() as Array<{ email: string, primary: boolean, verified: boolean }>
          const primary = emails.find(e => e.primary && e.verified) ?? emails.find(e => e.verified) ?? emails[0]
          if (primary) {
            email = primary.email
            emailVerified = primary.verified
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
