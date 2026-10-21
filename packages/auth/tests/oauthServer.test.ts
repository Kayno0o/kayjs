import { createHash } from 'node:crypto'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { Elysia } from 'elysia'
import { memoryStore } from '../src/memoryStore'
import { authPages } from '../src/pages'
import { browser as browserOf, testApp } from './helpers/app'

const PASSWORD = 'correct horse battery'
const REDIRECT = 'http://127.0.0.1:33418/callback'
const VERIFIER = 'v'.repeat(64)
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')
const DOCUMENT = 'https://client.example/oauth/client.json'

afterEach(() => {
  setSystemTime()
})

function server(options: { documents?: Record<string, unknown>, scopes?: ('posts:read' | 'posts:write')[], defaultScopes?: ('posts:read' | 'posts:write')[], store?: ReturnType<typeof memoryStore> } = {}) {
  const fetched: string[] = []
  const app = testApp({
    url: 'http://localhost',
    pages: authPages(),
    scopes: options.scopes ?? ['posts:read', 'posts:write'],
    ...options.store && { store: options.store },
    oauthServer: {
      ...options.defaultScopes && { defaultScopes: options.defaultScopes },
      fetch: async (url) => {
        fetched.push(url)

        return options.documents && url in options.documents ? Response.json(options.documents[url]) : new Response('missing', { status: 404 })
      },
    },
  })

  return { ...app, fetched }
}

type Server = ReturnType<typeof server>

async function register(app: Server, redirectUris: string[] = [REDIRECT]) {
  const response = await app.browser().fetch('/auth/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: redirectUris }) })

  return await response.json() as { client_id: string }
}

function params(clientId: string, extra: Record<string, string> = {}) {
  return { client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: CHALLENGE, code_challenge_method: 'S256', scope: 'posts:read', state: 'abc', ...extra }
}

async function signedIn(app: Server) {
  const ada = app.browser()

  await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

  return ada
}

// Approves `clientId` as the signed-in user and answers the code it was given.
async function approved(ada: Awaited<ReturnType<typeof signedIn>>, clientId: string, extra: Record<string, string> = {}) {
  const answer = await ada.post('/call/oauthDecide', [params(clientId, extra), true]) as { ok: true, redirect: string }

  return new URL(answer.redirect).searchParams.get('code')!
}

async function token(app: Server, form: Record<string, string>) {
  const response = await app.browser().fetch('/auth/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) })

  return { status: response.status, body: await response.json() as Record<string, string | number> }
}

async function exchange(app: Server, clientId: string, code: string, extra: Record<string, string> = {}) {
  return token(app, { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: clientId, redirect_uri: REDIRECT, ...extra })
}

describe('client registration', () => {
  test('gives a public client an id', async () => {
    const app = server()
    const response = await app.browser().fetch('/auth/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: [REDIRECT] }) })

    expect(response.status).toBe(201)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(await response.json()).toMatchObject({ client_id: expect.stringMatching(/^kc_/), client_name: 'Claude Code', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' })
  })

  test.each([
    ['a script URI', { redirect_uris: ['javascript:alert(1)'] }],
    ['plain http beyond the machine', { redirect_uris: ['http://evil.example/cb'] }],
    ['a fragment', { redirect_uris: ['https://app.example/cb#x'] }],
    ['none', { redirect_uris: [] }],
    ['a secret-holding client', { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' }],
  ])('refuses %s', async (_name, body) => {
    const response = await server().browser().fetch('/auth/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

    expect(response.status).toBe(400)
  })

  test('refuses a body that is not JSON, and one that is too large', async () => {
    const app = server()

    expect((await app.browser().fetch('/auth/oauth/register', { method: 'POST', body: 'nope' })).status).toBe(400)
    expect((await app.browser().fetch('/auth/oauth/register', { method: 'POST', body: JSON.stringify({ redirect_uris: [REDIRECT], padding: 'x'.repeat(20000) }) })).status).toBe(400)
  })
})

describe('the authorization request', () => {
  test('sends a signed-out visitor to sign in', async () => {
    const app = server()
    const { client_id } = await register(app)

    expect(await app.browser().call('oauthAuthorize', params(client_id))).toEqual({ kind: 'sign-in' })
  })

  test('never redirects to an unknown client or an unregistered redirect URI', async () => {
    const app = server()
    const { client_id } = await register(app)
    const ada = await signedIn(app)

    expect(await ada.call('oauthAuthorize', params('kc_unknown'))).toEqual({ kind: 'error', error: 'client' })
    expect(await ada.call('oauthAuthorize', params(client_id, { redirect_uri: 'http://evil.example/callback' }))).toEqual({ kind: 'error', error: 'redirect_uri' })
    expect(await ada.call('oauthAuthorize', params(client_id, { redirect_uri: 'javascript:alert(1)' }))).toEqual({ kind: 'error', error: 'redirect_uri' })
    expect(await ada.call('oauthAuthorize', params(client_id, { redirect_uri: `${REDIRECT}/../other` }))).toEqual({ kind: 'error', error: 'redirect_uri' })
    expect(await ada.call('oauthAuthorize', params(client_id, { redirect_uri: 'http://127.0.0.1:33418@evil.example/callback' }))).toEqual({ kind: 'error', error: 'redirect_uri' })
  })

  test('takes a loopback redirect on any port', async () => {
    const app = server()
    const { client_id } = await register(app)
    const ada = await signedIn(app)

    expect(await ada.call('oauthAuthorize', params(client_id, { redirect_uri: 'http://127.0.0.1:51234/callback' }))).toMatchObject({ kind: 'consent' })
    expect(await ada.call('oauthAuthorize', params(client_id, { redirect_uri: 'http://127.0.0.1:51234/other' }))).toEqual({ kind: 'error', error: 'redirect_uri' })
  })

  test('answers a bad request to the client, with the state and the issuer', async () => {
    const app = server()
    const { client_id } = await register(app)
    const ada = await signedIn(app)

    for (const [extra, error] of [[{ code_challenge_method: 'plain' }, 'invalid_request'], [{ code_challenge: 'short' }, 'invalid_request'], [{ response_type: 'token' }, 'unsupported_response_type'], [{ scope: 'admin' }, 'invalid_scope'], [{ resource: 'https://other.example/mcp' }, 'invalid_target']] as const) {
      const outcome = await ada.call('oauthAuthorize', params(client_id, extra)) as { kind: string, url: string }
      const url = new URL(outcome.url)

      expect(outcome.kind).toBe('redirect')
      expect(url.searchParams.get('error')).toBe(error)
      expect(url.searchParams.get('state')).toBe('abc')
      expect(url.searchParams.get('iss')).toBe('http://localhost')
    }
  })

  test('a client asking for no scope gets none, or the app\'s default ones, never every scope', async () => {
    const bare = server()
    const { client_id } = await register(bare)
    const ada = await signedIn(bare)

    expect(await ada.call('oauthAuthorize', params(client_id, { scope: '' }))).toMatchObject({ kind: 'consent', scopes: [] })
    expect(await ada.call('oauthAuthorize', params(client_id, { scope: 'offline_access' }))).toMatchObject({ kind: 'consent', scopes: [] })

    const withDefault = server({ defaultScopes: ['posts:read'] })
    const other = await register(withDefault)
    const grace = await signedIn(withDefault)

    expect(await grace.call('oauthAuthorize', params(other.client_id, { scope: '' }))).toMatchObject({ kind: 'consent', scopes: ['posts:read'] })
  })

  test('a default scope the app does not declare is refused at startup', () => {
    expect(() => testApp({ url: 'http://localhost', pages: authPages(), scopes: ['posts:read'], oauthServer: { defaultScopes: ['posts:write'] } } as never)).toThrow('defaultScopes')
  })

  test('shows the consent page once, then skips it until the client asks for more scopes', async () => {
    const app = server()
    const { client_id } = await register(app)
    const ada = await signedIn(app)

    expect(await ada.call('oauthAuthorize', params(client_id))).toMatchObject({ kind: 'consent', client: { name: 'Claude Code' }, scopes: ['posts:read'] })

    const code = await approved(ada, client_id)

    expect(code).toBeTruthy()

    const again = await ada.call('oauthAuthorize', params(client_id)) as { kind: string, url: string }

    expect(again.kind).toBe('redirect')
    expect(new URL(again.url).searchParams.get('code')).toBeTruthy()
    expect(await ada.call('oauthAuthorize', params(client_id, { scope: 'posts:read posts:write' }))).toMatchObject({ kind: 'consent', scopes: ['posts:read', 'posts:write'] })
    expect(await ada.call('oauthAuthorize', params(client_id, { prompt: 'consent' }))).toMatchObject({ kind: 'consent' })
  })

  test('an approval held with every scope, from an app declaring none, asks again once the app declares some', async () => {
    const store = memoryStore()
    const before = server({ scopes: [], store })
    const { client_id } = await register(before)
    const ada = await signedIn(before)
    const first = await exchange(before, client_id, await approved(ada, client_id))
    const pending = await approved(ada, client_id)
    const after = server({ store })
    const again = after.browser()

    await again.post('/password', { identifier: 'ada@example.com', password: PASSWORD })

    expect(await again.call('oauthAuthorize', params(client_id))).toMatchObject({ kind: 'consent', scopes: ['posts:read'] })
    // A code given before the app declared scopes is refused, as it would give every one.
    expect((await exchange(after, client_id, pending)).body.error).toBe('invalid_grant')
    // A refresh token issued under it is refused too, as it would hold every scope the app declares now.
    expect((await token(after, { grant_type: 'refresh_token', refresh_token: String(first.body.refresh_token), client_id })).body.error).toBe('invalid_grant')

    await again.post('/call/oauthDecide', [params(client_id), true])

    expect(await again.call('listOAuthClients')).toEqual([expect.objectContaining({ scopes: ['posts:read'] })])
    expect(await again.call('oauthAuthorize', params(client_id))).toMatchObject({ kind: 'redirect' })
    expect(await again.call('oauthAuthorize', params(client_id, { scope: 'posts:write' }))).toMatchObject({ kind: 'consent' })
  })

  test('a denial goes back to the client without a code', async () => {
    const app = server()
    const { client_id } = await register(app)
    const ada = await signedIn(app)
    const answer = await ada.post('/call/oauthDecide', [params(client_id), false]) as { ok: true, redirect: string }
    const url = new URL(answer.redirect)

    expect(url.searchParams.get('error')).toBe('access_denied')
    expect(url.searchParams.has('code')).toBe(false)
  })

  test('the consent answer is checked again: a forged redirect URI or a signed-out browser gets nothing', async () => {
    const app = server()
    const { client_id } = await register(app)
    const ada = await signedIn(app)

    expect(await ada.post('/call/oauthDecide', [params(client_id, { redirect_uri: 'http://evil.example/cb' }), true])).toEqual({ ok: false, error: 'redirect_uri' })
    expect(await app.browser().post('/call/oauthDecide', [params(client_id), true])).toEqual({ ok: false, error: 'signed-out' })
  })

  test('a bearer token cannot approve a client', async () => {
    const app = server()
    const { client_id } = await register(app)
    const ada = await signedIn(app)
    const minted = await ada.callOk('createToken', { password: PASSWORD }, 'Phone')
    const outcome = await app.browser().fetch('/call/oauthAuthorize', { method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${minted.token}` }, body: JSON.stringify([params(client_id)]) })

    expect(await outcome.json()).toEqual({ kind: 'sign-in' })
  })
})

describe('client ID metadata documents', () => {
  test('a client named by a document URL needs no registration', async () => {
    const app = server({ documents: { [DOCUMENT]: { client_id: DOCUMENT, client_name: 'Inspector', redirect_uris: [REDIRECT] } } })
    const ada = await signedIn(app)

    expect(await ada.call('oauthAuthorize', params(DOCUMENT))).toMatchObject({ kind: 'consent', client: { id: DOCUMENT, name: 'Inspector', host: 'client.example' } })
    expect(await ada.call('oauthAuthorize', params(DOCUMENT))).toMatchObject({ kind: 'consent' })
    expect(app.fetched).toEqual([DOCUMENT])
  })

  test('a document naming another client_id, or none, is refused', async () => {
    const app = server({ documents: { [DOCUMENT]: { client_id: 'https://other.example/x', redirect_uris: [REDIRECT] } } })
    const ada = await signedIn(app)

    expect(await ada.call('oauthAuthorize', params(DOCUMENT))).toEqual({ kind: 'error', error: 'client' })
    expect(await ada.call('oauthAuthorize', params('https://missing.example/client.json'))).toEqual({ kind: 'error', error: 'client' })
  })
})

describe('the token endpoint', () => {
  test('exchanges a code for a bearer token that reads as its user, with the scopes it was approved for', async () => {
    const app = server()
    const { client_id } = await register(app)
    const ada = await signedIn(app)
    const reply = await exchange(app, client_id, await approved(ada, client_id))

    const bearer = `Bearer ${reply.body.access_token}`

    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'posts:read', access_token: expect.any(String), refresh_token: expect.any(String) })

    expect(await app.browser().json('/me', { headers: { authorization: bearer } })).toMatchObject({ email: 'ada@example.com' })

    const { id } = await ada.json('/me') as { id: string }

    expect((await app.store.bearerTokens.listByUser(id)).map(each => each.scopes)).toEqual([['posts:read']])
    expect(await ada.call('listTokens')).toEqual([])
  })

  test('a client asking no scope gets a token and a refresh that reach only routes with scope false', async () => {
    const app = server()
    const { client_id } = await register(app)
    const ada = await signedIn(app)
    const first = await exchange(app, client_id, await approved(ada, client_id, { scope: '' }))
    const api = new Elysia().use(app.auth.gate()).get('/posts', () => 'ok', { scope: 'posts:read' }).get('/health', () => 'ok', { scope: false })
    const device = browserOf(new Elysia().use(app.app).group('/api', group => group.use(api)))
    const get = async (path: string, access: string | number | undefined) => device.fetch(`/api${path}`, { headers: { authorization: `Bearer ${access}` } })

    expect(first.status).toBe(200)
    expect(first.body.scope).toBeUndefined()
    expect((await get('/posts', first.body.access_token)).status).toBe(403)
    expect((await get('/health', first.body.access_token)).status).toBe(200)

    const { id } = await ada.json('/me') as { id: string }

    expect((await app.store.bearerTokens.listByUser(id)).map(each => each.scopes)).toEqual([[]])

    const second = await token(app, { grant_type: 'refresh_token', refresh_token: String(first.body.refresh_token), client_id })

    expect(second.status).toBe(200)
    expect((await get('/posts', second.body.access_token)).status).toBe(403)
    expect(await ada.call('listOAuthClients')).toEqual([expect.objectContaining({ scopes: [] })])
  })

  test('refuses a wrong PKCE verifier, and the code is spent by the try', async () => {
    const app = server()
    const { client_id } = await register(app)
    const ada = await signedIn(app)
    const code = await approved(ada, client_id)

    expect((await exchange(app, client_id, code, { code_verifier: 'w'.repeat(64) })).body.error).toBe('invalid_grant')
    expect((await exchange(app, client_id, code)).body.error).toBe('invalid_grant')
  })

  test('refuses a code of another client, or another redirect URI', async () => {
    const app = server()
    const { client_id } = await register(app)
    const other = await register(app)
    const ada = await signedIn(app)

    expect((await exchange(app, other.client_id, await approved(ada, client_id))).body.error).toBe('invalid_grant')
    expect((await exchange(app, client_id, await approved(ada, client_id), { redirect_uri: 'http://127.0.0.1:1/callback' })).body.error).toBe('invalid_grant')
  })

  test('refuses an expired code', async () => {
    const app = server()
    const { client_id } = await register(app)
    const ada = await signedIn(app)
    const code = await approved(ada, client_id)

    setSystemTime(Date.now() + 61 * 1000)

    expect((await exchange(app, client_id, code)).body.error).toBe('invalid_grant')
  })

  test('a code used twice ends the tokens it gave', async () => {
    const app = server()
    const { client_id } = await register(app)
    const ada = await signedIn(app)
    const code = await approved(ada, client_id)
    const first = await exchange(app, client_id, code)

    expect((await exchange(app, client_id, code)).body.error).toBe('invalid_grant')
    expect(await app.browser().json('/me', { headers: { authorization: `Bearer ${first.body.access_token}` } })).toBe('anonymous')
    expect((await token(app, { grant_type: 'refresh_token', refresh_token: String(first.body.refresh_token), client_id })).body.error).toBe('invalid_grant')
  })

  test('refuses what it does not support', async () => {
    const app = server()

    expect((await token(app, { grant_type: 'password' })).body.error).toBe('unsupported_grant_type')
    expect((await token(app, { grant_type: 'authorization_code' })).body.error).toBe('invalid_request')
  })

  test('answers a preflight', async () => {
    const response = await server().browser().fetch('/auth/oauth/token', { method: 'OPTIONS' })

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })
})

describe('refresh tokens', () => {
  async function signedInClient() {
    const app = server()
    const { client_id } = await register(app)
    const ada = await signedIn(app)
    const first = await exchange(app, client_id, await approved(ada, client_id))

    return { app, ada, client_id, first }
  }

  test('rotate: each refresh gives a new pair and the old refresh token is spent', async () => {
    const { app, client_id, first } = await signedInClient()
    const second = await token(app, { grant_type: 'refresh_token', refresh_token: String(first.body.refresh_token), client_id })

    expect(second.status).toBe(200)
    expect(second.body.refresh_token).not.toBe(first.body.refresh_token)
    expect(await app.browser().json('/me', { headers: { authorization: `Bearer ${second.body.access_token}` } })).toMatchObject({ email: 'ada@example.com' })
  })

  test('one used again after rotation ends the whole family', async () => {
    const { app, client_id, first } = await signedInClient()
    const second = await token(app, { grant_type: 'refresh_token', refresh_token: String(first.body.refresh_token), client_id })

    expect((await token(app, { grant_type: 'refresh_token', refresh_token: String(first.body.refresh_token), client_id })).body.error).toBe('invalid_grant')
    expect((await token(app, { grant_type: 'refresh_token', refresh_token: String(second.body.refresh_token), client_id })).body.error).toBe('invalid_grant')
    expect(await app.browser().json('/me', { headers: { authorization: `Bearer ${second.body.access_token}` } })).toBe('anonymous')
  })

  test('cannot add scopes', async () => {
    const { app, client_id, first } = await signedInClient()

    expect((await token(app, { grant_type: 'refresh_token', refresh_token: String(first.body.refresh_token), client_id, scope: 'posts:read posts:write' })).body.error).toBe('invalid_scope')
  })

  test('is refused to another client', async () => {
    const { app, first } = await signedInClient()
    const other = await register(app)

    expect((await token(app, { grant_type: 'refresh_token', refresh_token: String(first.body.refresh_token), client_id: other.client_id })).body.error).toBe('invalid_grant')
  })

  test('expires after thirty days', async () => {
    const { app, client_id, first } = await signedInClient()

    setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000)

    expect((await token(app, { grant_type: 'refresh_token', refresh_token: String(first.body.refresh_token), client_id })).body.error).toBe('invalid_grant')
  })

  test('a family ends ninety days after its first token, however often it rotates', async () => {
    const { app, client_id, first } = await signedInClient()
    const day = 24 * 60 * 60 * 1000
    const start = Date.now()
    let refresh = String(first.body.refresh_token)

    for (const elapsed of [20, 40, 60, 80]) {
      setSystemTime(start + elapsed * day)

      const next = await token(app, { grant_type: 'refresh_token', refresh_token: refresh, client_id })

      expect(next.status).toBe(200)
      refresh = String(next.body.refresh_token)
    }

    setSystemTime(start + 100 * day)

    expect((await token(app, { grant_type: 'refresh_token', refresh_token: refresh, client_id })).body.error).toBe('invalid_grant')
  })

  test('a refresh token unused for thirty days is refused inside its family', async () => {
    const { app, client_id, first } = await signedInClient()

    setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000)

    expect((await token(app, { grant_type: 'refresh_token', refresh_token: String(first.body.refresh_token), client_id })).body.error).toBe('invalid_grant')
  })

  test('the last use of an approved app is its last call, not its last refresh', async () => {
    const { app, ada, client_id, first } = await signedInClient()

    expect(await ada.call('listOAuthClients')).toEqual([expect.objectContaining({ lastUsedAt: null })])

    const second = await token(app, { grant_type: 'refresh_token', refresh_token: String(first.body.refresh_token), client_id })

    expect(await ada.call('listOAuthClients')).toEqual([expect.objectContaining({ lastUsedAt: null })])

    await app.browser().json('/me', { headers: { authorization: `Bearer ${second.body.access_token}` } })

    expect(await ada.call('listOAuthClients')).toEqual([expect.objectContaining({ lastUsedAt: expect.any(String) })])
  })

  test('stop working once the user revokes the client, with its access token', async () => {
    const { app, ada, client_id, first } = await signedInClient()

    expect(await ada.call('listOAuthClients')).toEqual([expect.objectContaining({ id: client_id, name: 'Claude Code', scopes: ['posts:read'] })])
    expect(await ada.call('revokeOAuthClient', client_id)).toBe(true)
    expect(await ada.call('revokeOAuthClient', client_id)).toBe(false)
    expect(await ada.call('listOAuthClients')).toEqual([])
    expect((await token(app, { grant_type: 'refresh_token', refresh_token: String(first.body.refresh_token), client_id })).body.error).toBe('invalid_grant')
    expect(await app.browser().json('/me', { headers: { authorization: `Bearer ${first.body.access_token}` } })).toBe('anonymous')
    expect(await ada.call('oauthAuthorize', params(client_id))).toMatchObject({ kind: 'consent' })
  })

  test('stop working once the user signs out everywhere', async () => {
    const { app, ada, client_id, first } = await signedInClient()

    await ada.post('/sign-out-everywhere', {})

    expect((await token(app, { grant_type: 'refresh_token', refresh_token: String(first.body.refresh_token), client_id })).body.error).toBe('invalid_grant')
  })
})

describe('the OAuth server being off', () => {
  test('serves nothing without pages, or with oauthServer false', async () => {
    const plain = testApp({ url: 'http://localhost' })
    const off = testApp({ url: 'http://localhost', pages: authPages(), oauthServer: false })

    for (const app of [plain, off]) {
      expect((await app.browser().fetch('/.well-known/oauth-authorization-server')).status).toBe(404)
      expect((await app.browser().fetch('/auth/oauth/token', { method: 'POST', body: '' })).status).toBe(404)
      expect(await app.browser().call('oauthAuthorize', params('x'))).toEqual({ kind: 'error', error: 'client' })
    }
  })
})
