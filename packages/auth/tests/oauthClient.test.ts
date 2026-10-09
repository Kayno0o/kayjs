import { afterEach, describe, expect, test } from 'bun:test'
import { createOAuthClient, OAuthExchangeError } from '../src/oauth/client'
import { discordProvider, githubProvider } from '../src/oauth/providers'

const CONFIG = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://app.test/cb' }

interface FetchCall { url: string, init?: RequestInit | undefined }

const realFetch = globalThis.fetch

function mockFetch(handler: (call: FetchCall) => Response): FetchCall[] {
  const calls: FetchCall[] = []

  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const call = { url: String(input), init }

    calls.push(call)

    return handler(call)
  }) as typeof fetch

  return calls
}

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('createOAuthClient.authorizeUrl', () => {
  test('builds the authorize URL with scope, state and PKCE challenge', () => {
    const client = createOAuthClient(discordProvider(), CONFIG)
    const url = new URL(client.authorizeUrl({ state: 'st', codeChallenge: 'chal' }))

    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe('identify email')
    expect(url.searchParams.get('state')).toBe('st')
    expect(url.searchParams.get('code_challenge')).toBe('chal')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  test('omits state and PKCE params when not supplied', () => {
    const client = createOAuthClient(discordProvider(), CONFIG)
    const url = new URL(client.authorizeUrl())

    expect(url.searchParams.has('state')).toBe(false)
    expect(url.searchParams.has('code_challenge')).toBe(false)
  })
})

describe('createOAuthClient.exchangeCode', () => {
  test('posts the code + PKCE verifier and parses a JSON token payload', async () => {
    const calls = mockFetch(() => new Response(
      JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'Bearer' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    const client = createOAuthClient(discordProvider(), CONFIG)

    const tokens = await client.exchangeCode('the-code', { codeVerifier: 'ver' })

    expect(tokens.accessToken).toBe('at')
    expect(tokens.refreshToken).toBe('rt')
    expect(tokens.expiresAt).toBeGreaterThan(Date.now())

    const body = calls[0]!.init!.body as URLSearchParams

    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('the-code')
    expect(body.get('code_verifier')).toBe('ver')
  })

  test('parses a form-encoded token payload (GitHub) via content-type detection', async () => {
    mockFetch(() => new Response('access_token=at&token_type=bearer&scope=read%3Auser', {
      status: 200,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }))
    const client = createOAuthClient(githubProvider(), CONFIG)

    const tokens = await client.exchangeCode('c')

    expect(tokens.accessToken).toBe('at')
    // GitHub classic tokens do not expire.
    expect(tokens.expiresAt).toBeUndefined()
  })

  test('refreshTokens posts a refresh_token grant', async () => {
    const calls = mockFetch(() => new Response(
      JSON.stringify({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    const client = createOAuthClient(discordProvider(), CONFIG)

    const tokens = await client.refreshTokens('rt')

    expect(tokens.accessToken).toBe('at2')
    const body = calls[0]!.init!.body as URLSearchParams

    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('rt')
  })

  test('throws a redacted error when the token endpoint fails', async () => {
    mockFetch(() => new Response(`secret=${'x'.repeat(500)}`, { status: 400 }))
    const client = createOAuthClient(discordProvider(), CONFIG)

    let err: Error | undefined

    try {
      await client.exchangeCode('c')
    }
    catch (e) {
      err = e as Error
    }

    expect(err).toBeInstanceOf(OAuthExchangeError)
    expect((err as OAuthExchangeError).status).toBe(400)
    expect(err!.message).toContain('OAuth token request failed (discord): 400')
    expect(err!.message).toContain('...')
    expect(err!.message.length).toBeLessThan(300)
  })
})

describe('createOAuthClient.fetchUser', () => {
  test('sends the bearer token and normalizes the provider user', async () => {
    const calls = mockFetch(() => new Response(
      JSON.stringify({ id: '42', username: 'bob', global_name: 'Bob', avatar: 'a', email: 'b@t.co', verified: true }),
      { status: 200 },
    ))
    const client = createOAuthClient(discordProvider(), CONFIG)

    const user = await client.fetchUser('tok')

    expect(user).toEqual({ providerId: '42', username: 'bob', displayName: 'Bob', avatar: 'a', email: 'b@t.co' })
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer tok')
  })

  test('throws an OAuthExchangeError carrying the upstream status when the user endpoint returns non-2xx', async () => {
    mockFetch(() => new Response('nope', { status: 401 }))
    const client = createOAuthClient(discordProvider(), CONFIG)

    let err: unknown

    try {
      await client.fetchUser('tok')
    }
    catch (e) {
      err = e
    }

    expect(err).toBeInstanceOf(OAuthExchangeError)
    expect((err as OAuthExchangeError).status).toBe(401)
    expect((err as OAuthExchangeError).message).toContain('OAuth user fetch failed (discord): 401')
  })
})

describe('provider presets', () => {
  test('githubProvider normalizes ids to strings and sends a User-Agent', () => {
    const gh = githubProvider()

    expect(gh.authHeaders?.('t')).toMatchObject({ 'User-Agent': '@kaynooo/kayjs-auth' })
    expect(gh.normalizeUser({ id: 7, login: 'oz', name: 'Oz', avatar_url: 'u', email: null }))
      .toEqual({ providerId: '7', username: 'oz', displayName: 'Oz', avatar: 'u', email: null })
  })

  test('discordProvider reports an email only once Discord verified it', () => {
    const discord = discordProvider()

    expect(discord.normalizeUser({ id: '1', username: 'a', email: 'a@t.co', verified: false }).email).toBeNull()
    expect(discord.normalizeUser({ id: '1', username: 'a', email: 'a@t.co' }).email).toBeNull()
    expect(discord.normalizeUser({ id: '1', username: 'a', email: 'a@t.co', verified: true }).email).toBe('a@t.co')
  })

  test('parseTokens rejects a payload with no access_token', () => {
    expect(() => discordProvider().parseTokens({ error: 'invalid_grant' })).toThrow('missing access_token: invalid_grant')
  })
})
