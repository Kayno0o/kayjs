import { createHash } from 'node:crypto'
import { afterEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test'
import { authPages } from '../src/pages'
import { testApp } from './helpers/app'

const PASSWORD = 'correct horse battery'
const REDIRECT = 'http://127.0.0.1:33418/callback'
const VERIFIER = 'v'.repeat(64)
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')

afterEach(() => {
  setSystemTime()
})

function server(options: { scopes?: ('posts:read')[], oauthServer?: boolean } = {}) {
  return testApp({ url: 'http://localhost', pages: authPages(), scopes: options.scopes ?? ['posts:read'], ...options.oauthServer === undefined ? {} : { oauthServer: options.oauthServer } } as never)
}

type Server = ReturnType<typeof server>

async function register(app: Server) {
  const response = await app.browser().fetch('/auth/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: [REDIRECT] }) })

  return (await response.json() as { client_id: string }).client_id
}

async function tokens(app: Server) {
  const clientId = await register(app)
  const ada = app.browser()

  await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

  const params = { client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: CHALLENGE, code_challenge_method: 'S256', scope: 'posts:read', state: 'abc' }
  const answer = await ada.post('/call/oauthDecide', [params, true]) as { redirect: string }
  const code = new URL(answer.redirect).searchParams.get('code')!
  const reply = await post(app, 'token', { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: clientId, redirect_uri: REDIRECT })

  return { clientId, access: String(reply.body.access_token), refresh: String(reply.body.refresh_token) }
}

async function post(app: Server, endpoint: string, form: Record<string, string>) {
  const response = await app.browser().fetch(`/auth/oauth/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) })

  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

const who = async (app: Server, access: string) => app.browser().json('/me', { headers: { authorization: `Bearer ${access}` } })

describe('the revocation endpoint (RFC 7009)', () => {
  test('is advertised in the server metadata', async () => {
    const metadata = await server().browser().json('/.well-known/oauth-authorization-server') as Record<string, unknown>

    expect(metadata).toMatchObject({ revocation_endpoint: 'http://localhost/auth/oauth/revoke', revocation_endpoint_auth_methods_supported: ['none'] })
  })

  test('revoking the access token ends the refresh token with it', async () => {
    const app = server()
    const { clientId, access, refresh } = await tokens(app)

    expect(await who(app, access)).toMatchObject({ email: 'ada@example.com' })
    expect(await post(app, 'revoke', { token: access, client_id: clientId })).toEqual({ status: 200, body: {} })
    expect(await who(app, access)).toBe('anonymous')
    expect((await post(app, 'token', { grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId })).body.error).toBe('invalid_grant')
  })

  test('revoking the refresh token ends the access token with it', async () => {
    const app = server()
    const { clientId, access, refresh } = await tokens(app)

    expect((await post(app, 'revoke', { token: refresh, client_id: clientId, token_type_hint: 'refresh_token' })).status).toBe(200)
    expect(await who(app, access)).toBe('anonymous')
    expect((await post(app, 'token', { grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId })).body.error).toBe('invalid_grant')
  })

  test('answers 200 and revokes nothing for another client\'s token or an unknown one', async () => {
    const app = server()
    const { clientId, access, refresh } = await tokens(app)
    const other = await register(app)

    expect((await post(app, 'revoke', { token: access, client_id: other })).status).toBe(200)
    expect((await post(app, 'revoke', { token: refresh, client_id: other })).status).toBe(200)
    expect((await post(app, 'revoke', { token: 'unknown'.repeat(8), client_id: clientId })).status).toBe(200)
    expect(await who(app, access)).toMatchObject({ email: 'ada@example.com' })
    expect((await post(app, 'token', { grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId })).status).toBe(200)
  })

  test('does not revoke a token that is no OAuth token', async () => {
    const app = server()
    const { clientId, access } = await tokens(app)
    const grace = app.browser()
    const { user } = await grace.callHas('user', 'register', { email: 'grace@example.com', password: PASSWORD })
    const minted = await app.auth.issueToken(user.id, 'Phone')

    expect(minted.ok && (await post(app, 'revoke', { token: minted.token, client_id: clientId })).status).toBe(200)
    expect(await who(app, minted.ok ? minted.token : '')).toMatchObject({ email: 'grace@example.com' })
    expect(await who(app, access)).toMatchObject({ email: 'ada@example.com' })
  })

  test('counts its own budget, apart from the token endpoint', async () => {
    const app = testApp({ url: 'http://localhost', pages: authPages(), scopes: ['posts:read'], rateLimit: { oauthToken: { max: 2, window: 900 } } } as never)
    const statuses = []

    for (let attempt = 0; attempt < 3; attempt++)
      statuses.push((await post(app, 'revoke', { token: 'x', client_id: 'kc_x' })).status)

    expect(statuses).toEqual([200, 200, 429])
    expect((await post(app, 'token', { grant_type: 'password' })).status).toBe(400)
  })

  test('needs the token and the client', async () => {
    const app = server()

    expect((await post(app, 'revoke', { token: 'x' })).body.error).toBe('invalid_request')
    expect((await post(app, 'revoke', { client_id: 'kc_x' })).status).toBe(400)
  })

  test('answers a browser client\'s preflight', async () => {
    const preflight = await server().browser().fetch('/auth/oauth/revoke', { method: 'OPTIONS', headers: { 'origin': 'https://client.example', 'access-control-request-method': 'POST' } })

    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
  })
})

describe('an OAuth server without declared scopes', () => {
  test('warns at boot when the app switched it on', () => {
    const warned = spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      testApp({ url: 'http://localhost', pages: authPages(), oauthServer: true })
      expect(warned.mock.calls.flat().join(' ')).toContain('declares no `scopes`')
    }
    finally {
      warned.mockRestore()
    }
  })

  test.each([
    ['declared scopes', { pages: authPages(), scopes: ['posts:read'], oauthServer: true }],
    ['only the default, off the pages', { pages: authPages() }],
  ])('stays quiet with %s', (_name, options) => {
    const warned = spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      testApp({ url: 'http://localhost', ...options } as never)
      expect(warned.mock.calls.flat().join(' ')).not.toContain('declares no `scopes`')
    }
    finally {
      warned.mockRestore()
    }
  })
})
