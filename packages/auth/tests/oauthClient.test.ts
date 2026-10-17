import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { log } from '../src/log'
import { createOAuthClient, OAuthExchangeError } from '../src/oauth/client'
import { appleProvider, discordProvider, githubProvider, gitlabProvider, oidcProvider } from '../src/oauth/providers'

const CONFIG = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://app.test/cb' }

interface FetchCall { url: string, init?: RequestInit | undefined }

const realFetch = globalThis.fetch

function mockFetch(handler: (call: FetchCall) => Response): FetchCall[] {
  const calls: FetchCall[] = []

  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
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
  test('builds the authorize URL with scope, state and PKCE challenge', async () => {
    const client = createOAuthClient(discordProvider(), CONFIG)
    const url = new URL(await client.authorizeUrl({ state: 'st', codeChallenge: 'chal' }))

    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe('identify email')
    expect(url.searchParams.get('state')).toBe('st')
    expect(url.searchParams.get('code_challenge')).toBe('chal')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  test('omits state and PKCE params when not supplied', async () => {
    const client = createOAuthClient(discordProvider(), CONFIG)
    const url = new URL(await client.authorizeUrl())

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

    expect(user).toEqual({ providerId: '42', username: 'bob', displayName: 'Bob', avatar: 'https://cdn.discordapp.com/avatars/42/a.png', banner: null, email: 'b@t.co' })
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
  test('discordProvider gives the avatar and the banner as CDN URLs, an animated one as a gif', () => {
    const discord = discordProvider()

    expect(discord.normalizeUser({ id: '42', username: 'bob', avatar: 'a_anim', banner: 'still' })).toMatchObject({ avatar: 'https://cdn.discordapp.com/avatars/42/a_anim.gif', banner: 'https://cdn.discordapp.com/banners/42/still.png' })
    expect(discord.normalizeUser({ id: '42', username: 'bob', avatar: null })).toMatchObject({ avatar: null, banner: null })
  })

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
    expect(() => discordProvider().parseTokens({ access_token: '' })).toThrow('OAuth token response missing access_token')
    expect(() => discordProvider().parseTokens({ access_token: 42, error: '' })).toThrow(/missing access_token$/)
  })
})

describe('a provider out of reach or answering nonsense', () => {
  // What `AbortSignal.timeout` throws once the provider has not answered in time.
  const timedOut = (): Response => {
    throw new DOMException('The operation timed out.', 'TimeoutError')
  }

  async function failure(run: () => Promise<unknown>): Promise<OAuthExchangeError> {
    let err: unknown

    try {
      await run()
    }
    catch (e) {
      err = e
    }

    expect(err).toBeInstanceOf(OAuthExchangeError)

    return err as OAuthExchangeError
  }

  test('a token, refresh or user request the provider does not answer in time fails as the provider down', async () => {
    const calls = mockFetch(timedOut)
    const client = createOAuthClient(discordProvider(), CONFIG)

    expect((await failure(async () => client.exchangeCode('c'))).status).toBe(502)
    expect((await failure(async () => client.refreshTokens('rt'))).status).toBe(502)
    expect((await failure(async () => client.fetchUser('tok'))).status).toBe(502)
    expect(calls.map(call => call.init?.signal instanceof AbortSignal)).toEqual([true, true, true])
  })

  test('a discovery document the provider does not serve in time fails as the provider down', async () => {
    const calls = mockFetch(timedOut)
    const client = createOAuthClient(oidcProvider({ issuer: 'https://idp.test' }), CONFIG)

    expect((await failure(async () => client.authorizeUrl())).status).toBe(502)
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal)
  })

  test('a token or user answer that is not JSON, or holds no access token, fails as the provider down', async () => {
    const client = createOAuthClient(discordProvider(), CONFIG)

    mockFetch(() => new Response('<html>maintenance</html>', { status: 200, headers: { 'content-type': 'application/json' } }))
    expect((await failure(async () => client.exchangeCode('c'))).status).toBe(502)
    expect((await failure(async () => client.fetchUser('tok'))).status).toBe(502)

    mockFetch(() => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    expect((await failure(async () => client.exchangeCode('c'))).status).toBe(502)
  })
})

describe('githubProvider email', () => {
  const profile = { id: 7, login: 'oz', name: 'Oz', avatar_url: 'u', email: null }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const signIn = async (emails: Response | (() => Response), scope: string | undefined, raw: Record<string, unknown> = profile) => {
    const answer = () => typeof emails === 'function' ? emails() : emails
    const calls = mockFetch(({ url }) => url.endsWith('/user/emails') ? answer() : json(raw))
    const user = await createOAuthClient(githubProvider({ scopes: ['read:user', 'user:email'] }), CONFIG).readUser({ accessToken: 'at', scope })

    return { user, calls }
  }

  test('a user hiding their email signs in with the primary verified address', async () => {
    const { user, calls } = await signIn(json([{ email: 'old@t.co', primary: false, verified: true }, { email: 'main@t.co', primary: true, verified: true }]), 'read:user,user:email')

    expect(user.email).toBe('main@t.co')
    expect(calls.map(call => call.url)).toEqual(['https://api.github.com/user', 'https://api.github.com/user/emails'])
    expect(new Headers(calls[1]!.init?.headers).get('authorization')).toBe('Bearer at')
  })

  test('an unverified primary and a verified address that is not the primary give none', async () => {
    expect((await signIn(json([{ email: 'main@t.co', primary: true, verified: false }]), 'user:email')).user.email).toBeNull()
    expect((await signIn(json([{ email: 'main@t.co', primary: true, verified: false }, { email: 'other@t.co', primary: false, verified: true }]), 'user:email')).user.email).toBeNull()
  })

  test('the profile\'s public email is kept when the list holds no primary verified one', async () => {
    expect((await signIn(json([]), 'user:email', { ...profile, email: 'public@t.co' })).user.email).toBe('public@t.co')
  })

  test('without the user:email scope /user/emails is not asked', async () => {
    const { user, calls } = await signIn(json([{ email: 'main@t.co', primary: true, verified: true }]), 'read:user')

    expect(user.email).toBeNull()
    expect(calls).toHaveLength(1)
  })

  test('the scope asked for counts when GitHub names none, and the broader user scope counts', async () => {
    expect((await signIn(json([{ email: 'main@t.co', primary: true, verified: true }]), undefined)).user.email).toBe('main@t.co')
    expect((await signIn(json([{ email: 'main@t.co', primary: true, verified: true }]), 'user')).user.email).toBe('main@t.co')
  })

  test('a failing /user/emails, an HTML answer or a malformed list leaves the sign-in going with the profile\'s email', async () => {
    expect((await signIn(json({ message: 'nope' }, 403), 'user:email', { ...profile, email: 'public@t.co' })).user.email).toBe('public@t.co')
    expect((await signIn(() => {
      throw new Error('connection reset')
    }, 'user:email')).user.email).toBeNull()
    expect((await signIn(new Response('<html>', { status: 200 }), 'user:email')).user.email).toBeNull()
    expect((await signIn(json({ not: 'a list' }), 'user:email')).user.email).toBeNull()
    expect((await signIn(json([null, 'x', { email: 7, primary: true, verified: true }]), 'user:email')).user.email).toBeNull()
  })

  test('the scope of a form-encoded token answer, comma separated, carries through exchangeCode into readUser', async () => {
    const calls = mockFetch(({ url }) => {
      if (url.endsWith('/user/emails'))
        return json([{ email: 'main@t.co', primary: true, verified: true }])

      return url.endsWith('/login/oauth/access_token')
        ? new Response('access_token=at&token_type=bearer&scope=read%3Auser%2Cuser%3Aemail', { status: 200, headers: { 'content-type': 'application/x-www-form-urlencoded' } })
        : json(profile)
    })
    const client = createOAuthClient(githubProvider(), CONFIG)
    const tokens = await client.exchangeCode('c')

    expect(tokens.scope).toBe('read:user,user:email')
    expect((await client.readUser(tokens)).email).toBe('main@t.co')
    expect(calls.at(-1)!.url).toBe('https://api.github.com/user/emails')
  })

  test('fetchUser reads the emails by the scopes asked for', async () => {
    mockFetch(({ url }) => url.endsWith('/user/emails') ? json([{ email: 'main@t.co', primary: true, verified: true }]) : json(profile))

    expect((await createOAuthClient(githubProvider({ scopes: ['user:email'] }), CONFIG).fetchUser('at')).email).toBe('main@t.co')
  })
})

describe('provider options', () => {
  test('GitHub Enterprise takes a base url, with a trailing slash or a path', () => {
    for (const url of ['https://git.example.com/', 'https://git.example.com///']) {
      expect(githubProvider({ url })).toMatchObject({ authorizeUrl: 'https://git.example.com/login/oauth/authorize', tokenUrl: 'https://git.example.com/login/oauth/access_token', userUrl: 'https://git.example.com/api/v3/user' })
    }

    expect(githubProvider({ url: 'https://example.com/github/' })).toMatchObject({ authorizeUrl: 'https://example.com/github/login/oauth/authorize', userUrl: 'https://example.com/github/api/v3/user' })
  })

  test('the Discord and GitLab urls drop trailing slashes and keep paths; apiBase still works', () => {
    expect(discordProvider({ url: 'https://proxy.test/discord/api/' })).toMatchObject({ tokenUrl: 'https://proxy.test/discord/api/oauth2/token', userUrl: 'https://proxy.test/discord/api/users/@me' })
    expect(discordProvider({ apiBase: 'https://old.test/api/' })).toMatchObject({ tokenUrl: 'https://old.test/api/oauth2/token' })
    expect(discordProvider({ url: 'https://new.test', apiBase: 'https://old.test' }).tokenUrl).toBe('https://new.test/oauth2/token')
    expect(discordProvider().tokenUrl).toBe('https://discord.com/api/v10/oauth2/token')
    expect(gitlabProvider({ url: 'https://lab.test/gitlab/' })).toMatchObject({ authorizeUrl: 'https://lab.test/gitlab/oauth/authorize', userUrl: 'https://lab.test/gitlab/oauth/userinfo' })
  })

  test('apiBase warns that it is url, and an empty url is refused', () => {
    const warn = spyOn(log, 'warn').mockImplementation(() => undefined)

    try {
      discordProvider({ apiBase: 'https://old.test' })
      discordProvider({ url: 'https://new.test' })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]![0])).toContain('apiBase')
    }
    finally {
      warn.mockRestore()
    }

    expect(() => githubProvider({ url: '/' })).toThrow('empty')
    expect(() => discordProvider({ url: '' })).toThrow('empty')
  })

  test('production refuses a plain-http url', () => {
    const before = process.env.NODE_ENV ?? 'test'

    process.env.NODE_ENV = 'production'

    try {
      expect(() => githubProvider({ url: 'http://git.example.com' })).toThrow('not https')
      expect(() => discordProvider({ url: 'http://proxy.test' })).toThrow('not https')
      expect(() => discordProvider({ apiBase: 'http://proxy.test' })).toThrow('not https')
    }
    finally {
      process.env.NODE_ENV = before
    }
  })

  test('every preset takes scopes and params into the authorize URL', async () => {
    const apple = appleProvider({ teamId: 't', keyId: 'k', privateKey: 'p', scopes: ['email'], params: { prompt: 'login' } })

    expect(apple.authorizeParams).toEqual({ prompt: 'login', response_mode: 'form_post' })
    expect(appleProvider({ teamId: 't', keyId: 'k', privateKey: 'p', params: { response_mode: 'query' } }).authorizeParams).toEqual({ response_mode: 'form_post' })

    const github = new URL(await createOAuthClient(githubProvider({ scopes: ['repo'], params: { allow_signup: 'false' } }), CONFIG).authorizeUrl({ state: 's' }))
    const discord = new URL(await createOAuthClient(discordProvider({ scopes: ['identify'], params: { prompt: 'none' } }), CONFIG).authorizeUrl({ state: 's' }))

    expect([github.searchParams.get('scope'), github.searchParams.get('allow_signup')]).toEqual(['repo', 'false'])
    expect([discord.searchParams.get('scope'), discord.searchParams.get('prompt')]).toEqual(['identify', 'none'])
  })
})
