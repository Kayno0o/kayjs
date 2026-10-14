import type { Profile } from '../src/auth'
import type { OAuthProvider } from '../src/oauth/types'
import { afterEach, describe, expect, test } from 'bun:test'
import { exportJWK, exportPKCS8, generateKeyPair, importJWK, jwtVerify, SignJWT } from 'jose'
import { appleProvider, gitlabProvider, googleProvider, microsoftProvider, oidcProvider } from '../src/oauth/providers'
import { testApp } from './helpers/app'

const realFetch = globalThis.fetch
const PERSONAL_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad'
const WORK_TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47'
const signing = await generateKeyPair('RS256')
const stranger = await generateKeyPair('RS256')
const JWK = { ...await exportJWK(signing.publicKey), kid: 'k1', alg: 'RS256', use: 'sig' }
const apple = await generateKeyPair('ES256', { extractable: true })
const APPLE = { teamId: 'TEAM123', keyId: 'KEY123', privateKey: await exportPKCS8(apple.privateKey) }

afterEach(() => {
  globalThis.fetch = realFetch
})

interface Endpoints { token: string, jwks: string, user?: string, discovery?: { url: string, doc: Record<string, unknown> } }

// Stands in for an OpenID provider: a code is `code-<sub>`, answered with an access token `token-<sub>` and an ID token carrying the account's claims, signed with the key its JWKS serves.
function provider(issuer: string, endpoints: Endpoints, accounts: Record<string, Record<string, unknown>>) {
  const mock = {
    nonce: undefined as string | undefined,
    // Claims set over every ID token's, to forge one.
    token: {} as Record<string, unknown>,
    userinfo: {} as Record<string, unknown>,
    key: signing.privateKey as CryptoKey | Uint8Array,
    // The header's `alg`, and the keys the JWKS serves.
    alg: 'RS256',
    jwks: [JWK] as Record<string, unknown>[],
    // Sent as the whole ID token when set, to hand over one the mock did not sign.
    rawToken: undefined as string | undefined,
    discoveryDown: false,
    calls: [] as { url: string, body: URLSearchParams }[],
  }

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = new URLSearchParams(init?.body as string | undefined)

    mock.calls.push({ url, body })

    if (url === endpoints.discovery?.url)
      return mock.discoveryDown ? new Response('down', { status: 503 }) : Response.json(endpoints.discovery.doc)

    if (url === endpoints.jwks)
      return Response.json({ keys: mock.jwks })

    if (url === endpoints.token) {
      const sub = body.get('code')!.slice('code-'.length)
      const now = Math.floor(Date.now() / 1000)
      const claims = { iss: issuer, aud: body.get('client_id')!, sub, iat: now, exp: now + 300, ...mock.nonce === undefined ? {} : { nonce: mock.nonce }, ...accounts[sub], ...mock.token }
      const idToken = mock.rawToken ?? await new SignJWT(claims).setProtectedHeader({ alg: mock.alg, kid: 'k1' }).sign(mock.key)

      return Response.json({ access_token: `token-${sub}`, id_token: idToken, expires_in: 3600 })
    }

    if (url === endpoints.user) {
      const sub = (new Headers(init?.headers).get('authorization') ?? '').slice('Bearer token-'.length)

      return Response.json({ sub, ...accounts[sub], ...mock.userinfo })
    }

    return new Response('no', { status: 404 })
  }) as typeof fetch

  return mock
}

function setup(name: string, oauthProvider: OAuthProvider<any, any>, clientSecret: string | undefined = 'secret') {
  const signUps: Profile[] = []
  const app = testApp({
    url: 'https://site.test',
    signInPage: '/login',
    oauth: { [name]: { provider: oauthProvider, clientId: 'client-id', ...clientSecret === undefined ? {} : { clientSecret } } },
    onSignUp: (_user, profile) => {
      signUps.push(profile!)
    },
  })

  // Leaves for the provider and comes back with the code it gives `sub`, the nonce sent along handed to the mock.
  const signIn = async (mock: { nonce: string | undefined }, sub: string, visitor = app.browser()) => {
    const leaving = await visitor.fetch(`/auth/${name}`)
    const location = new URL(leaving.headers.get('location')!)

    mock.nonce = location.searchParams.get('nonce') ?? undefined

    const back = await visitor.fetch(`/auth/${name}/callback?code=code-${sub}&state=${location.searchParams.get('state')}`)

    return { location, landed: back.headers.get('location'), visitor }
  }

  return { ...app, signUps, signIn }
}

describe('any OpenID Connect provider', () => {
  const ISSUER = 'https://id.example.test/realms/main'
  const ENDPOINTS: Endpoints = {
    token: `${ISSUER}/token`,
    jwks: `${ISSUER}/certs`,
    user: `${ISSUER}/userinfo`,
    discovery: {
      url: `${ISSUER}/.well-known/openid-configuration`,
      doc: { issuer: ISSUER, authorization_endpoint: `${ISSUER}/auth`, token_endpoint: `${ISSUER}/token`, userinfo_endpoint: `${ISSUER}/userinfo`, jwks_uri: `${ISSUER}/certs` },
    },
  }
  const ACCOUNTS = { ada: { preferred_username: 'ada', name: 'Ada Lovelace', email: 'ada@example.com', email_verified: true } }

  test('its endpoints are read once off its discovery document, and its ID token signs the user in', async () => {
    const mock = provider(ISSUER, ENDPOINTS, ACCOUNTS)
    const { signIn, signUps } = setup('keycloak', oidcProvider({ issuer: `${ISSUER}/` }))
    const { location, landed, visitor } = await signIn(mock, 'ada')

    expect(location.origin + location.pathname).toBe(`${ISSUER}/auth`)
    expect(location.searchParams.get('scope')).toBe('openid email profile')
    expect(location.searchParams.get('nonce')).toMatch(/^\S{16,}$/)
    expect(landed).toBe('/')
    expect(await visitor.json('/me')).toMatchObject({ email: 'ada@example.com', emailVerified: true, username: 'ada' })
    expect(signUps[0]).toMatchObject({ provider: 'keycloak', providerId: 'ada', displayName: 'Ada Lovelace' })

    await signIn(mock, 'ada')

    expect(mock.calls.filter(call => call.url === ENDPOINTS.discovery!.url)).toHaveLength(1)
  })

  test('an ID token that is forged, expired, for another client or sign-in, or from another issuer signs nobody in', async () => {
    const now = Math.floor(Date.now() / 1000)
    const forgeries: [string, Record<string, unknown>, CryptoKey?][] = [
      ['another key', {}, stranger.privateKey],
      ['expired', { iat: now - 3600, exp: now - 120 }],
      ['another client', { aud: 'other-client' }],
      ['shared with another client', { aud: ['client-id', 'other-client'], azp: 'other-client' }],
      ['another sign-in', { nonce: 'not-this-one' }],
      ['another issuer', { iss: 'https://evil.test' }],
      ['no subject', { sub: undefined }],
    ]

    for (const [forgery, claims, key] of forgeries) {
      const mock = provider(ISSUER, ENDPOINTS, ACCOUNTS)
      const { signIn, store } = setup('keycloak', oidcProvider({ issuer: ISSUER }))

      mock.token = claims
      mock.key = key ?? signing.privateKey

      expect([forgery, (await signIn(mock, 'ada')).landed]).toEqual([forgery, '/login?error=oauth'])
      expect(await store.users.findByEmail('ada@example.com')).toBeUndefined()
    }
  })

  test('an ID token signed with none, a shared secret or an algorithm outside the list signs nobody in', async () => {
    const rs384 = await generateKeyPair('RS384')
    const rs384Jwk = { ...await exportJWK(rs384.publicKey), kid: 'k1', use: 'sig' }
    const now = Math.floor(Date.now() / 1000)
    const claims = { iss: ISSUER, aud: 'client-id', sub: 'ada', iat: now, exp: now + 300 }
    const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const hmac = new TextEncoder().encode(JSON.stringify(JWK))
    const cases: [string, (mock: ReturnType<typeof provider>) => void][] = [
      ['alg none', (mock) => {
        mock.rawToken = `${base64url({ alg: 'none', kid: 'k1' })}.${base64url(claims)}.`
      }],
      ['alg none with a stripped signature', (mock) => {
        mock.rawToken = `${base64url({ alg: 'none' })}.${base64url(claims)}`
      }],
      ['HS256 keyed with the public key', (mock) => {
        mock.alg = 'HS256'
        mock.key = hmac
      }],
      ['HS256 keyed with the public key, the JWKS entry a symmetric one', (mock) => {
        mock.alg = 'HS256'
        mock.key = hmac
        mock.jwks = [{ kty: 'oct', k: Buffer.from(hmac).toString('base64url'), kid: 'k1', alg: 'HS256' }]
      }],
    ]

    for (const [name, forge] of cases) {
      const mock = provider(ISSUER, ENDPOINTS, ACCOUNTS)
      const { signIn, store } = setup('keycloak', oidcProvider({ issuer: ISSUER }))

      forge(mock)

      expect([name, (await signIn(mock, 'ada')).landed]).toEqual([name, '/login?error=oauth'])
      expect(await store.users.findByEmail('ada@example.com')).toBeUndefined()
    }

    // An RS384 token is taken by default, and refused once the app narrows the list to RS256.
    for (const [algorithms, landed] of [[undefined, '/'], [['RS384'], '/'], [['RS256'], '/login?error=oauth']] as const) {
      const mock = provider(ISSUER, ENDPOINTS, ACCOUNTS)
      const { signIn } = setup('keycloak', oidcProvider({ issuer: ISSUER, ...algorithms && { algorithms: [...algorithms] } }))

      mock.alg = 'RS384'
      mock.key = rs384.privateKey
      mock.jwks = [rs384Jwk]

      expect([algorithms, (await signIn(mock, 'ada')).landed]).toEqual([algorithms, landed])
    }

    // A list without RS256 refuses an RS256 token.
    const strict = provider(ISSUER, ENDPOINTS, ACCOUNTS)
    const { signIn: strictSignIn } = setup('keycloak', oidcProvider({ issuer: ISSUER, algorithms: ['ES256'] }))

    expect((await strictSignIn(strict, 'ada')).landed).toBe('/login?error=oauth')
  })

  test('the user endpoint answering for another account than the token\'s signs nobody in', async () => {
    const mock = provider(ISSUER, ENDPOINTS, ACCOUNTS)
    const { signIn } = setup('keycloak', oidcProvider({ issuer: ISSUER }))

    mock.userinfo = { sub: 'eve' }

    expect((await signIn(mock, 'ada')).landed).toBe('/login?error=unavailable')
  })

  test('an unverified email is left out', async () => {
    const mock = provider(ISSUER, ENDPOINTS, { ada: { ...ACCOUNTS.ada, email_verified: false } })
    const { signIn } = setup('keycloak', oidcProvider({ issuer: ISSUER }))
    const { visitor } = await signIn(mock, 'ada')

    expect(await visitor.json('/me')).toMatchObject({ email: null, username: 'ada' })
  })

  test('a discovery document out of reach, or naming another issuer, is a provider unavailable, tried again on the next sign-in', async () => {
    const mock = provider(ISSUER, ENDPOINTS, ACCOUNTS)
    const { signIn, browser } = setup('keycloak', oidcProvider({ issuer: ISSUER }))

    mock.discoveryDown = true
    expect((await browser().fetch('/auth/keycloak')).headers.get('location')).toBe('/login?error=unavailable')

    mock.discoveryDown = false
    expect((await signIn(mock, 'ada')).landed).toBe('/')

    const lying = provider(ISSUER, { ...ENDPOINTS, discovery: { url: ENDPOINTS.discovery!.url, doc: { ...ENDPOINTS.discovery!.doc, issuer: 'https://evil.test' } } }, ACCOUNTS)
    const other = setup('keycloak', oidcProvider({ issuer: ISSUER }))

    expect((await other.browser().fetch('/auth/keycloak')).headers.get('location')).toBe('/login?error=unavailable')
    expect(lying.calls.some(call => call.url === ENDPOINTS.token)).toBe(false)
  })
})

describe('Google', () => {
  const ENDPOINTS = { token: 'https://oauth2.googleapis.com/token', jwks: 'https://www.googleapis.com/oauth2/v3/certs' }

  test('signs in off the ID token alone, its email only once Google verified it', async () => {
    const mock = provider('https://accounts.google.com', ENDPOINTS, {
      1: { email: 'ada@gmail.com', email_verified: true, name: 'Ada', picture: 'https://lh3.test/ada.png' },
      2: { email: 'bob@gmail.com', email_verified: false },
    })
    const { signIn, signUps } = setup('google', googleProvider({ params: { access_type: 'offline', prompt: 'consent' } }))
    const { location, visitor } = await signIn(mock, '1')

    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(location.searchParams.get('access_type')).toBe('offline')
    expect(await visitor.json('/me')).toMatchObject({ email: 'ada@gmail.com', username: null })
    expect(signUps[0]).toMatchObject({ providerId: '1', displayName: 'Ada', avatar: 'https://lh3.test/ada.png', email: 'ada@gmail.com' })

    await signIn(mock, '2')

    expect(signUps[1]).toMatchObject({ providerId: '2', email: null })
  })

  test('takes the issuer Google writes without its scheme', async () => {
    const mock = provider('accounts.google.com', ENDPOINTS, { 1: { email: 'ada@gmail.com', email_verified: true } })
    const { signIn } = setup('google', googleProvider())

    expect((await signIn(mock, '1')).landed).toBe('/')
  })
})

describe('Microsoft', () => {
  const ENDPOINTS = { token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', jwks: 'https://login.microsoftonline.com/common/discovery/v2.0/keys' }
  const issuer = (tid: string) => ({ tid, iss: `https://login.microsoftonline.com/${tid}/v2.0` })

  test('signs in personal and work accounts, a work account\'s email kept only once its domain is vouched for', async () => {
    const mock = provider('unused', ENDPOINTS, {
      personal: { ...issuer(PERSONAL_TENANT), email: 'ada@outlook.com', name: 'Ada' },
      work: { ...issuer(WORK_TENANT), email: 'bob@contoso.com', preferred_username: 'bob@contoso.com' },
      vouched: { ...issuer(WORK_TENANT), email: 'eve@contoso.com', xms_edov: true },
    })
    const { signIn, signUps } = setup('microsoft', microsoftProvider())

    for (const account of ['personal', 'work', 'vouched'])
      expect((await signIn(mock, account)).landed).toBe('/')

    expect(signUps.map(profile => [profile.providerId, profile.email, profile.username])).toEqual([['personal', 'ada@outlook.com', ''], ['work', null, ''], ['vouched', 'eve@contoso.com', '']])
  })

  test('an issuer naming another tenant than the token\'s, or a tenant the app does not take, signs nobody in', async () => {
    const mock = provider('unused', { token: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token', jwks: 'https://login.microsoftonline.com/organizations/discovery/v2.0/keys' }, {
      personal: issuer(PERSONAL_TENANT),
      forged: { tid: WORK_TENANT, iss: `https://login.microsoftonline.com/${PERSONAL_TENANT}/v2.0` },
      work: issuer(WORK_TENANT),
    })
    const { signIn } = setup('microsoft', microsoftProvider({ tenant: 'organizations' }))

    expect((await signIn(mock, 'personal')).landed).toBe('/login?error=oauth')
    expect((await signIn(mock, 'forged')).landed).toBe('/login?error=oauth')
    expect((await signIn(mock, 'work')).landed).toBe('/')
  })
})

describe('GitLab', () => {
  test('signs in on a self-hosted instance, the user endpoint\'s answer over the ID token', async () => {
    const base = 'https://git.example.test'
    const mock = provider(base, { token: `${base}/oauth/token`, jwks: `${base}/oauth/discovery/keys`, user: `${base}/oauth/userinfo` }, { 7: { nickname: 'ada', preferred_username: 'ada', email: 'ada@example.test', email_verified: true } })
    const { signIn } = setup('gitlab', gitlabProvider({ url: `${base}/` }))

    mock.userinfo = { name: 'Ada L.', picture: `${base}/ada.png` }

    const { location, visitor } = await signIn(mock, '7')

    expect(location.origin + location.pathname).toBe(`${base}/oauth/authorize`)
    expect(await visitor.json('/me')).toMatchObject({ email: 'ada@example.test', username: 'ada' })
  })
})

describe('the algorithms option of the Google, Microsoft and GitLab presets', () => {
  const GITLAB = 'https://git.example.test'
  const presets: [string, (algorithms?: string[]) => OAuthProvider<any, any>, string, Endpoints, Record<string, unknown>][] = [
    ['google', algorithms => googleProvider({ ...algorithms && { algorithms } }), 'https://accounts.google.com', { token: 'https://oauth2.googleapis.com/token', jwks: 'https://www.googleapis.com/oauth2/v3/certs' }, { email: 'ada@gmail.com', email_verified: true }],
    ['microsoft', algorithms => microsoftProvider({ ...algorithms && { algorithms } }), `https://login.microsoftonline.com/${WORK_TENANT}/v2.0`, { token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', jwks: 'https://login.microsoftonline.com/common/discovery/v2.0/keys' }, { tid: WORK_TENANT }],
    ['gitlab', algorithms => gitlabProvider({ url: GITLAB, ...algorithms && { algorithms } }), GITLAB, { token: `${GITLAB}/oauth/token`, jwks: `${GITLAB}/oauth/discovery/keys`, user: `${GITLAB}/oauth/userinfo` }, { preferred_username: 'ada' }],
  ]

  test('each preset refuses a token signed outside its list, and takes one inside it', async () => {
    const rs384 = await generateKeyPair('RS384')
    const rs384Jwk = { ...await exportJWK(rs384.publicKey), kid: 'k1', use: 'sig' }

    for (const [name, make, issuer, endpoints, account] of presets) {
      // An RS384 token is taken by default and when listed, refused once the app names RS256 or ES256 only.
      for (const [algorithms, landed] of [[undefined, '/'], [['RS384'], '/'], [['RS256'], '/login?error=oauth'], [['ES256', 'PS256'], '/login?error=oauth']] as const) {
        const mock = provider(issuer, endpoints, { ada: account })
        const { signIn } = setup(name, make(algorithms && [...algorithms]))

        mock.alg = 'RS384'
        mock.key = rs384.privateKey
        mock.jwks = [rs384Jwk]

        expect([name, algorithms, (await signIn(mock, 'ada')).landed]).toEqual([name, algorithms, landed])
      }

      // An RS256 token is refused by a list without RS256.
      const mock = provider(issuer, endpoints, { ada: account })
      const { signIn } = setup(name, make(['ES256']))

      expect([name, (await signIn(mock, 'ada')).landed]).toEqual([name, '/login?error=oauth'])
    }
  })

  test('a GitLab on http is refused in production, where the app is created and so at every sign-in', () => {
    const realEnv = process.env.NODE_ENV

    process.env.NODE_ENV = 'production'

    try {
      expect(() => setup('gitlab', gitlabProvider({ url: 'http://git.example.test' }))).toThrow('https')
      expect(() => setup('gitlab', gitlabProvider({ url: 'HTTP://git.example.test' }))).toThrow('https')
      expect(() => setup('gitlab', gitlabProvider({ url: GITLAB }))).not.toThrow()
    }
    finally {
      if (realEnv === undefined)
        delete process.env.NODE_ENV
      else
        process.env.NODE_ENV = realEnv
    }
  })
})

describe('Apple', () => {
  const ENDPOINTS = { token: 'https://appleid.apple.com/auth/token', jwks: 'https://appleid.apple.com/auth/keys' }

  test('comes back with a POST, turned into a GET the session cookie rides on, and names the user on their first sign-in only', async () => {
    const mock = provider('https://appleid.apple.com', ENDPOINTS, { '001.ada': { email: 'ada@privaterelay.appleid.com', email_verified: 'true', is_private_email: 'true' } })
    const { browser, signUps } = setup('apple', appleProvider(APPLE), undefined)
    const ada = browser()
    const leaving = new URL((await ada.fetch('/auth/apple')).headers.get('location')!)

    expect(leaving.searchParams.get('response_mode')).toBe('form_post')
    expect(leaving.searchParams.get('scope')).toBe('name email')
    mock.nonce = leaving.searchParams.get('nonce')!

    // A cross-site POST: the session cookie stays behind.
    const posted = await browser().fetch('/auth/apple/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: 'code-001.ada', state: leaving.searchParams.get('state')!, id_token: 'ignored', user: JSON.stringify({ name: { firstName: 'Ada', lastName: 'Lovelace' }, email: 'ada@privaterelay.appleid.com' }) }),
    })
    const back = posted.headers.get('location')!

    expect(posted.status).toBe(303)
    expect(new URL(back, 'https://site.test').searchParams.has('id_token')).toBe(false)
    expect((await ada.fetch(back)).headers.get('location')).toBe('/')
    expect(await ada.json('/me')).toMatchObject({ email: 'ada@privaterelay.appleid.com', emailVerified: true })
    expect(signUps[0]).toMatchObject({ providerId: '001.ada', displayName: 'Ada Lovelace', username: '' })

    const secret = mock.calls.find(call => call.url === ENDPOINTS.token)!.body.get('client_secret')!
    const { payload, protectedHeader } = await jwtVerify(secret, await importJWK(await exportJWK(apple.publicKey), 'ES256'), { issuer: 'TEAM123', audience: 'https://appleid.apple.com', subject: 'client-id' })

    expect(protectedHeader).toMatchObject({ alg: 'ES256', kid: 'KEY123' })
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(15_777_000)
  })

  test('a POST to a provider the app has not configured is not found', async () => {
    const { browser } = setup('apple', appleProvider(APPLE), undefined)

    expect((await browser().fetch('/auth/nope/callback', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'code=x' })).status).toBe(404)
  })
})

describe('https issuers in production', () => {
  const realEnv = process.env.NODE_ENV ?? 'test'

  afterEach(() => {
    process.env.NODE_ENV = realEnv
  })

  test('an http issuer, or a GitLab on http, is refused where the app is created, and taken outside production', () => {
    process.env.NODE_ENV = 'production'

    expect(() => oidcProvider({ issuer: 'http://idp.test' })).toThrow('https')
    expect(() => oidcProvider({ issuer: 'HTTP://idp.test' })).toThrow('https')
    expect(() => oidcProvider({ issuer: 'ftp://idp.test' })).toThrow('https')
    expect(() => gitlabProvider({ url: 'http://git.test' })).toThrow('https')
    expect(() => oidcProvider({ issuer: 'https://idp.test' })).not.toThrow()

    process.env.NODE_ENV = 'development'

    expect(() => oidcProvider({ issuer: 'http://localhost:8080/realms/main' })).not.toThrow()
    expect(() => gitlabProvider({ url: 'http://git.test' })).not.toThrow()

    process.env.NODE_ENV = 'test'

    expect(() => oidcProvider({ issuer: 'http://idp.test' })).not.toThrow()
  })

  test('a discovery document naming an http endpoint is a provider unavailable in production, and fine in development', async () => {
    const issuer = 'https://id.example.test'

    for (const field of ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint', 'jwks_uri']) {
      const doc = { issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, userinfo_endpoint: `${issuer}/userinfo`, jwks_uri: `${issuer}/certs`, [field]: `http://evil.test/${field}` }

      for (const [env, expected] of [['development', false], ['production', true]] as const) {
        process.env.NODE_ENV = env
        provider(issuer, { token: `${issuer}/token`, jwks: `${issuer}/certs`, discovery: { url: `${issuer}/.well-known/openid-configuration`, doc } }, {})

        const { browser } = setup('idp', oidcProvider({ issuer }))
        const location = (await browser().fetch('/auth/idp')).headers.get('location')

        expect([field, env, location === '/login?error=unavailable']).toEqual([field, env, expected])
      }
    }
  })
})
