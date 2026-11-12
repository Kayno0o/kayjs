import type { OAuthProvider } from '../src/oauth/types'
import { afterEach, describe, expect, test } from 'bun:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { createOAuthClient } from '../src/oauth/client'
import { facebookProvider, linkedinProvider, slackProvider, twitchProvider, xProvider } from '../src/oauth/providers'
import { testApp } from './helpers/app'

const realFetch = globalThis.fetch
const signing = await generateKeyPair('RS256')
const JWK = { ...await exportJWK(signing.publicKey), kid: 'k1', alg: 'RS256', use: 'sig' }
const CONFIG = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://app.test/cb' }

const QUERY = /\?.*$/

function withoutQuery(url: string): string {
  return url.replace(QUERY, '')
}

interface Call { url: string, init?: RequestInit | undefined }

afterEach(() => {
  globalThis.fetch = realFetch
})

// Answers each URL with `answers[url]`, a Response or a function of the call, and keeps the calls.
function answer(answers: Record<string, (call: Call) => Response>): Call[] {
  const calls: Call[] = []

  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const call = { url: String(input), init }

    calls.push(call)

    return answers[withoutQuery(call.url)]?.(call) ?? new Response('no', { status: 404 })
  }) as typeof fetch

  return calls
}

async function idToken(issuer: string, claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000)

  return new SignJWT({ iss: issuer, aud: CONFIG.clientId, iat: now, exp: now + 300, ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).sign(signing.privateKey)
}

// The token and JWKS endpoints of an OpenID provider answering with an ID token of these claims.
function openIdProvider(provider: OAuthProvider, claims: Record<string, unknown>, userinfo?: Record<string, unknown>): Call[] {
  const issuer = typeof provider.openId?.issuer === 'string' ? provider.openId.issuer : ''

  return answer({
    [provider.tokenUrl!]: async () => Response.json({ access_token: 'at', id_token: await idToken(issuer, claims), expires_in: 3600 }),
    [provider.openId!.jwksUrl]: () => Response.json({ keys: [JWK] }),
    ...provider.userUrl === undefined ? {} : { [withoutQuery(provider.userUrl)]: () => Response.json({ sub: claims.sub, ...userinfo }) },
  } as unknown as Record<string, (call: Call) => Response>)
}

async function signInAs(provider: OAuthProvider, claims: Record<string, unknown>, userinfo?: Record<string, unknown>) {
  const calls = openIdProvider(provider, claims, userinfo)
  const client = createOAuthClient(provider, CONFIG)
  const tokens = await client.exchangeCode('code', { codeVerifier: 'v' })

  return { calls, user: await client.readUser(tokens) }
}

describe('LinkedIn', () => {
  test('uses its OpenID Connect endpoints and reads a verified email, no username', async () => {
    const provider = linkedinProvider()
    const url = new URL(await createOAuthClient(provider, CONFIG).authorizeUrl({ state: 's' }))

    expect(url.origin + url.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization')
    expect(url.searchParams.get('scope')).toBe('openid email profile')

    const { user } = await signInAs(provider, { sub: '782bbtaQ', name: 'John Doe', picture: 'https://media.licdn.com/p.png', email: 'doe@email.com', email_verified: true })

    expect(user).toEqual({ providerId: '782bbtaQ', username: '', displayName: 'John Doe', avatar: 'https://media.licdn.com/p.png', email: 'doe@email.com' })
  })

  test('an email LinkedIn does not call verified, or does not send, is left out', async () => {
    expect((await signInAs(linkedinProvider(), { sub: 'a', email: 'a@b.co' })).user.email).toBeNull()
    expect((await signInAs(linkedinProvider(), { sub: 'a' })).user.email).toBeNull()
  })

  test('an ID token from another issuer is refused', async () => {
    openIdProvider(linkedinProvider(), { sub: 'a', iss: 'https://evil.test' })

    const client = createOAuthClient(linkedinProvider(), CONFIG)

    await expect(client.readUser(await client.exchangeCode('code'))).rejects.toThrow('ID token refused')
  })
})

describe('Slack', () => {
  test('reads the user off the ID token, the user endpoint over it, and takes a team', async () => {
    const provider = slackProvider({ params: { team: 'T0123' } })
    const url = new URL(await createOAuthClient(provider, CONFIG).authorizeUrl({ state: 's' }))

    expect(url.origin + url.pathname).toBe('https://slack.com/openid/connect/authorize')
    expect(url.searchParams.get('team')).toBe('T0123')

    const { calls, user } = await signInAs(provider, { sub: 'U123', email: 'ada@slack.test', email_verified: true }, { ok: true, name: 'Ada', picture: 'https://avatars.slack-edge.com/a.png' })

    expect(user).toEqual({ providerId: 'U123', username: '', displayName: 'Ada', avatar: 'https://avatars.slack-edge.com/a.png', email: 'ada@slack.test' })
    expect(calls.map(call => call.url)).toContain('https://slack.com/api/openid.connect.userInfo')
  })

  test('a refused code, which Slack answers with ok false, fails the exchange', async () => {
    answer({ 'https://slack.com/api/openid.connect.token': () => Response.json({ ok: false, error: 'invalid_code' }) })

    await expect(createOAuthClient(slackProvider(), CONFIG).exchangeCode('c')).rejects.toThrow('invalid_code')
  })
})

describe('Twitch', () => {
  test('asks for the email, picture and name claims in the ID token, which Twitch gives only then', async () => {
    const url = new URL(await createOAuthClient(twitchProvider(), CONFIG).authorizeUrl({ state: 's', nonce: 'n' }))

    expect(url.origin + url.pathname).toBe('https://id.twitch.tv/oauth2/authorize')
    expect(url.searchParams.get('scope')).toBe('openid user:read:email')
    expect(JSON.parse(url.searchParams.get('claims')!)).toEqual({ id_token: { email: null, email_verified: null, picture: null, preferred_username: null } })
    expect(url.searchParams.get('nonce')).toBe('n')
  })

  test('signs the user in with their login as username', async () => {
    const { user } = await signInAs(twitchProvider(), { sub: '141981764', preferred_username: 'twitchdev', picture: 'https://static-cdn.jtvnw.net/p.png', email: 'dev@twitch.test', email_verified: true })

    expect(user).toEqual({ providerId: '141981764', username: 'twitchdev', displayName: undefined, avatar: 'https://static-cdn.jtvnw.net/p.png', email: 'dev@twitch.test' })
  })

  test('revokes a token with the client id', async () => {
    const calls = answer({ 'https://id.twitch.tv/oauth2/revoke': () => new Response(null, { status: 200 }) })

    expect(await createOAuthClient(twitchProvider(), CONFIG).revokeToken('at')).toBe(true)
    expect(new URLSearchParams(calls[0]!.init!.body as URLSearchParams).get('client_id')).toBe('cid')
  })
})

describe('X', () => {
  test('authenticates the app with a Basic header, with no credentials in the body', async () => {
    const calls = answer({ 'https://api.x.com/2/oauth2/token': () => Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 7200, token_type: 'bearer', scope: 'users.read tweet.read' }) })
    const client = createOAuthClient(xProvider(), { ...CONFIG, clientId: 'my id', clientSecret: 's:ecret' })
    const tokens = await client.exchangeCode('code', { codeVerifier: 'verifier' })
    const sent = calls[0]!.init!
    const body = sent.body as URLSearchParams

    expect(tokens).toMatchObject({ accessToken: 'at', refreshToken: 'rt' })
    expect((sent.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa('my%20id:s%3Aecret')}`)
    expect(body.has('client_id')).toBe(false)
    expect(body.has('client_secret')).toBe(false)
    expect(body.get('code_verifier')).toBe('verifier')
  })

  test('refreshes and revokes with the same header', async () => {
    const calls = answer({
      'https://api.x.com/2/oauth2/token': () => Response.json({ access_token: 'at2' }),
      'https://api.x.com/2/oauth2/revoke': () => Response.json({ revoked: true }),
    })
    const client = createOAuthClient(xProvider(), CONFIG)

    await client.refreshTokens('rt')
    expect(await client.revokeToken('at')).toBe(true)

    for (const call of calls)
      expect((call.init!.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa('cid:sec')}`)
  })

  test('reads users/me with the avatar field and gives no email', async () => {
    const calls = answer({ 'https://api.x.com/2/users/me': () => Response.json({ data: { id: '2244994945', name: 'X Dev', username: 'TwitterDev', profile_image_url: 'https://pbs.twimg.com/p.jpg' } }) })
    const user = await createOAuthClient(xProvider(), CONFIG).fetchUser('at')

    expect(user).toEqual({ providerId: '2244994945', username: 'TwitterDev', displayName: 'X Dev', avatar: 'https://pbs.twimg.com/p.jpg', email: null })
    expect(calls[0]!.url).toBe('https://api.x.com/2/users/me?user.fields=profile_image_url')
  })

  test('an answer with no data has no id, which the flow refuses', async () => {
    answer({ 'https://api.x.com/2/users/me': () => Response.json({ errors: [{ message: 'nope' }] }) })

    expect((await createOAuthClient(xProvider(), CONFIG).fetchUser('at')).providerId).toBe('')
  })

  test('sends the PKCE challenge and its scopes', async () => {
    const url = new URL(await createOAuthClient(xProvider(), CONFIG).authorizeUrl({ state: 's', codeChallenge: 'c' }))

    expect(url.origin + url.pathname).toBe('https://x.com/i/oauth2/authorize')
    expect(url.searchParams.get('scope')).toBe('users.read tweet.read')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })
})

describe('Facebook', () => {
  test('sends comma-separated scopes to the versioned dialog', async () => {
    const url = new URL(await createOAuthClient(facebookProvider(), CONFIG).authorizeUrl({ state: 's' }))

    expect(url.origin + url.pathname).toBe('https://www.facebook.com/v27.0/dialog/oauth')
    expect(url.searchParams.get('scope')).toBe('public_profile,email')
    expect(facebookProvider({ version: 'v30.0' }).tokenUrl).toBe('https://graph.facebook.com/v30.0/oauth/access_token')
  })

  test('reads the profile with the large picture, and no email when Facebook has none', async () => {
    const calls = answer({
      'https://graph.facebook.com/v27.0/me': call => Response.json(call.init?.headers && new Headers(call.init.headers).get('authorization') === 'Bearer at'
        ? { id: '1234', name: 'Ada', email: 'ada@fb.test', picture: { data: { url: 'https://scontent.test/ada.jpg' } } }
        : { id: '5678', name: 'No Mail' }),
    })
    const client = createOAuthClient(facebookProvider(), CONFIG)

    expect(await client.fetchUser('at')).toEqual({ providerId: '1234', username: '', displayName: 'Ada', avatar: 'https://scontent.test/ada.jpg', email: 'ada@fb.test' })
    expect(await client.fetchUser('other')).toMatchObject({ providerId: '5678', avatar: null, email: null })
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v27.0/me?fields=id,name,email,picture.type(large)')
  })
})

describe('signing in through oauthTest', () => {
  const SITE = 'https://site.test'

  test('each preset signs a stubbed account in under its own name', async () => {
    const providers = { linkedin: linkedinProvider(), facebook: facebookProvider(), twitch: twitchProvider(), slack: slackProvider(), x: xProvider() }
    const { app, store, auth } = testApp({ site: SITE, oauth: Object.fromEntries(Object.entries(providers).map(([name, provider]) => [name, { provider, clientId: `${name}-id`, clientSecret: 'secret' }])) })
    const cookies = new Bun.CookieMap()
    const site = {
      cookies,
      fetch: async (path: string) => {
        const response = await app.handle(new Request(`${SITE}${path}`, { headers: { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') } }))

        for (const line of response.headers.getSetCookie()) {
          const cookie = Bun.Cookie.parse(line)

          cookies.set(cookie.name, cookie.value)
        }

        return response
      },
    }
    const as = auth.test(site)

    for (const name of Object.keys(providers)) {
      await as.oauth.stub(name, { id: `${name}-user`, username: name, ...name === 'x' ? {} : { email: `${name}@example.com` } })

      expect([name, (await as.oauth.signIn(name)).headers.get('location')]).toEqual([name, '/'])
      expect([name, await store.identities.find(name, `${name}-user`) !== undefined]).toEqual([name, true])
    }

    expect(await store.users.findByEmail('x@example.com')).toBeFalsy()
  })
})
